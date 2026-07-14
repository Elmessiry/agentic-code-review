import { readCode } from "@/lib/guards/input-cap";
import { modelFor } from "@/lib/models";
import { overrideNotes, plan } from "@/lib/pipeline/plan";
import { fanOut } from "@/lib/pipeline/specialists";
import { synthesize } from "@/lib/pipeline/synthesize";
import { approxTokens } from "@/lib/prompts/shared-prefix";
import type { ReviewEvent } from "@/lib/pipeline/schema";

// The whole pipeline, on one connection: guard → tripwire → plan → specialists → synthesize.
//
// It replaces three routes, which is a deletion worth explaining rather than a tidy-up.
// /api/plan and /api/specialists existed to build the pipeline a step at a time, and
// while they existed the CLIENT was the orchestrator: it called plan, read the answer,
// decided what to do next, and called the next endpoint. That design has three costs
// that only get worse as the pipeline grows. Three public routes that each spend money
// on a model are three surfaces to rate-limit, cap and defend, and forgetting one is a
// bill. Three round trips from the browser add three cold starts to a request the user
// is watching. And pipeline state living in the client means the client can be lied to
// about what ran — the planner's decision is only trustworthy if the thing that acts on
// it is the same thing that made it.
//
// So the orchestration is here, on the server, and the browser's job shrinks to
// rendering events as they arrive.

// The ceiling for the whole pipeline, not one call. Planner, then a warm specialist,
// then a fan-out, then a streamed synthesis — each of which is allowed up to three
// attempts. The platform default (as low as 10s) would guillotine this mid-flight,
// after the upstream calls were already billed, and hand the user a raw 504 instead of
// the review they paid for. Requires Fluid Compute on the Hobby plan; lower to 60 if
// deploying without it.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const input = await readCode(request);
  if (!input.ok) return input.response;

  const code = input.code;

  // Resolved BEFORE any model call: modelFor throws by design on an unknown env
  // override, and a throw during payload construction would land after the planner had
  // already been billed — discarding paid-for work over a typo that was knowable up
  // front. Fail while failing is still free.
  let spec;
  try {
    spec = modelFor("specialist");
  } catch (error) {
    console.error("[review] model registry rejected the configuration", error);
    return Response.json(
      { error: "The review could not be configured. Try again." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const encoder = new TextEncoder();
  const specialistModel = spec;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The only place an event becomes bytes. Typed against the union in schema.ts, so
      // an event the UI knows about and the server never sends — or the reverse — is a
      // build error rather than a silently missing pipeline node.
      const send = (event: ReviewEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const { plan: decision, usage: planUsage } = await plan(code);

        send({
          type: "plan",
          plan: {
            ...decision,
            overrides: overrideNotes(code),
            costUsd: planUsage.costUsd,
          },
        });

        const fan = await fanOut(decision.agents, code, {
          onStart: (specialist) => send({ type: "specialist_start", specialist }),
          onOutcome: (outcome) =>
            outcome.ok
              ? send({
                  type: "specialist_done",
                  specialist: outcome.result.specialist,
                  findings: outcome.result.findings,
                  droppedLineRefs: outcome.result.droppedLineRefs,
                })
              : send({
                  type: "specialist_error",
                  specialist: outcome.failure.specialist,
                  error: outcome.failure.error,
                }),
        });

        // Synthesis needs something to synthesise. With no successful specialist there
        // is nothing to merge, nothing to reconcile, and no verdict that would mean
        // anything — so the call is skipped rather than paid for. The failure cards the
        // browser already received are the honest report of what happened.
        let synthesisUsd = 0;

        if (fan.results.length > 0) {
          const { synthesis, usage } = await synthesize(
            code,
            fan.results,
            fan.failures.map((f) => f.specialist),
            (text) => send({ type: "synthesis_delta", text }),
          );

          synthesisUsd = usage.costUsd;

          send({
            type: "synthesis_done",
            findings: synthesis.findings,
            verdict: synthesis.verdict,
          });
        }

        const prefixTokens = approxTokens(code);

        send({
          type: "done",
          cost: {
            planUsd: planUsage.costUsd,
            specialistsUsd: fan.costUsd,
            synthesisUsd,
            totalUsd: planUsage.costUsd + fan.costUsd + synthesisUsd,
          },
          // Everything needed to tell whether the caching strategy actually worked,
          // rather than whether it was configured. A cachedTokens of 0 across a
          // multi-specialist run means the prefix is not being reused, whatever the
          // code believes.
          cache: {
            mode: specialistModel.caching,
            model: specialistModel.id,
            prefixTokens,
            minCacheTokens: specialistModel.minCacheTokens,
            clearsFloor: prefixTokens >= specialistModel.minCacheTokens,
            cachedTokens: fan.cachedTokens,
            inputTokens: fan.inputTokens,
            hitRate: fan.inputTokens > 0 ? fan.cachedTokens / fan.inputTokens : 0,
          },
        });
      } catch (error) {
        // The response is a 200 that is already open — the status line went out before
        // the pipeline had done anything that could fail. So a failure here cannot be an
        // HTTP status; it has to be an event, and the browser has to render it as one.
        console.error("[review] pipeline failed", error);
        send({ type: "error", error: "The review could not be completed. Try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // Proxies that buffer a response to compress it will hold the whole stream and
      // deliver it in one lump at the end. That is not a slower stream, it is no stream:
      // every event arrives after the review is over.
      "X-Accel-Buffering": "no",
    },
  });
}
