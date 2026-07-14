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

// The platform's ceiling for the whole pipeline. Requires Fluid Compute on the Hobby
// plan; lower to 60 if deploying without it.
export const maxDuration = 300;

// The pipeline's OWN ceiling, and it is deliberately under the platform's.
//
// Every stage independently allows three attempts, so the worst case — planner, warm
// specialist, fan-out, and a streamed synthesis that each retry twice — adds up to
// something on the order of twelve minutes. Left to run into maxDuration, the platform
// kills the function mid-stream: the upstream calls are already billed, the connection
// dies without a terminal event, and the user is told nothing about why.
//
// So the pipeline stops itself first, with thirty seconds to spare, and spends them
// saying so. A budget you enforce is a budget; a budget the platform enforces for you
// is an outage.
const PIPELINE_BUDGET_MS = 270_000;

export async function POST(request: Request): Promise<Response> {
  const input = await readCode(request);
  if (!input.ok) return input.response;

  const code = input.code;

  // Resolved BEFORE any model call: modelFor throws by design on an unknown env
  // override, and a throw during payload construction would land after the planner had
  // already been billed — discarding paid-for work over a typo that was knowable up
  // front. Fail while failing is still free.
  let specialistModel;
  try {
    specialistModel = modelFor("specialist");
  } catch (error) {
    console.error("[review] model registry rejected the configuration", error);
    return Response.json(
      { error: "The review could not be configured. Try again." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Everything that can stop this pipeline early, in one signal that every model call
  // downstream obeys. Without it, a user who closes the tab two seconds in leaves the
  // planner, four specialists and the synthesizer running to completion and billing in
  // full for a review that nobody will ever read.
  const control = new AbortController();
  const stopOn = (reason: string) => () => {
    if (!control.signal.aborted) {
      console.warn(`[review] abandoning the pipeline: ${reason}`);
      control.abort(new Error(reason));
    }
  };

  const budget = setTimeout(stopOn("the pipeline ran out of time"), PIPELINE_BUDGET_MS);
  request.signal.addEventListener("abort", stopOn("the client disconnected"));

  const encoder = new TextEncoder();
  const spec = specialistModel;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The stream can be torn down under us — the browser hangs up, and the controller
      // is closed before the pipeline notices. Every enqueue after that throws, INCLUDING
      // the one in the catch block below, which would replace the real error with a
      // TypeError and let it escape as an unhandled rejection. So writing is guarded
      // once, here, and a dead stream simply stops being written to.
      let open = true;

      const send = (event: ReviewEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };

      try {
        const { plan: decision, usage: planUsage } = await plan(code, control.signal);

        send({
          type: "plan",
          plan: {
            ...decision,
            overrides: overrideNotes(code),
            costUsd: planUsage.costUsd,
          },
        });

        const fan = await fanOut(
          decision.agents,
          code,
          {
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
          },
          control.signal,
        );

        const synthesisUsd = await runSynthesis(
          code,
          decision.agents.length,
          fan,
          control.signal,
          send,
        );

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
            mode: spec.caching,
            model: spec.id,
            prefixTokens,
            minCacheTokens: spec.minCacheTokens,
            clearsFloor: prefixTokens >= spec.minCacheTokens,
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

        send({
          type: "error",
          error: control.signal.aborted
            ? "The review took too long and was stopped."
            : "The review could not be completed. Try again.",
        });
      } finally {
        clearTimeout(budget);

        if (open) {
          try {
            controller.close();
          } catch {
            // Already closed by a disconnecting client. Nothing to do, and nothing worth
            // throwing out of a finally block over.
          }
        }
      }
    },

    // The browser hung up. Stop the pipeline rather than finishing a review that will be
    // thrown away — this is the callback that turns a closed tab into an unbilled call.
    cancel() {
      stopOn("the client disconnected")();
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

// The synthesis step, and the two cases where the right move is not to take it.
//
// Synthesis is the most expensive call in the pipeline by a distance — measured at 70%
// of a review, roughly 2.5x what all the specialists cost together. Paying it to
// announce that nothing is wrong is the worst trade in the system. There is nothing to
// merge, nothing to rank, and no disagreement to resolve, so the verdict is written here
// instead, for free:
//
//   nobody was selected — the planner judged that no lens was worth running. That is a
//   real answer, and it still deserves a verdict rather than an empty page.
//
//   everybody ran and nobody found anything — an approval, arrived at honestly.
//
// The failure case is deliberately NOT folded into either shortcut. If a specialist
// died, an empty result set is not a clean bill of health, it is a review with a hole in
// it — and the synthesizer is the thing that knows how to say so. An outage must never
// be able to come out of this function looking like an approval.
async function runSynthesis(
  code: string,
  selected: number,
  fan: Awaited<ReturnType<typeof fanOut>>,
  signal: AbortSignal,
  send: (event: ReviewEvent) => void,
): Promise<number> {
  const approve = (text: string) => {
    send({ type: "synthesis_delta", text });
    send({ type: "synthesis_done", findings: [], verdict: "approve" });
    return 0;
  };

  if (selected === 0) {
    return approve(
      "The planner read this code and found no lens worth running on it — nothing here is exposed to an attacker, on a hot path, hard to follow, or hard to test. No specialist ran, so this review cost the planner alone.",
    );
  }

  // Every selected specialist failed. Nothing ran, so nothing can be concluded — and
  // saying "approve" here would be inventing a clean bill of health out of an outage.
  // The failure cards are already on the page; they are the honest report.
  if (fan.results.length === 0) return 0;

  const foundSomething = fan.results.some((r) => r.findings.length > 0);
  const everyoneReported = fan.failures.length === 0;

  if (!foundSomething && everyoneReported) {
    return approve(
      "Every specialist that ran read this code and found nothing worth raising. There was nothing to merge, rank or disagree about, so no synthesis call was made — this review cost what the specialists cost.",
    );
  }

  const { synthesis, usage } = await synthesize(
    code,
    fan.results,
    fan.failures.map((f) => f.specialist),
    (text) => send({ type: "synthesis_delta", text }),
    signal,
  );

  send({
    type: "synthesis_done",
    findings: synthesis.findings,
    verdict: synthesis.verdict,
  });

  return usage.costUsd;
}
