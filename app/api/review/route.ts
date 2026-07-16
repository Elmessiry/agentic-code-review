import { readCode } from "@/lib/guards/input-cap";
import { checkRateLimit } from "@/lib/guards/rate-limit";
import { checkSpendCap, recordSpend } from "@/lib/guards/spend-cap";
import { modelFor } from "@/lib/models";
import { billedSoFar, runReview } from "@/lib/pipeline/review";
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
// What is left here is the transport, and only the transport: the guard, the abort
// plumbing, and turning events into SSE frames. The pipeline itself lives in
// lib/pipeline/review.ts, because the eval harness has to score the same orchestration
// this route runs rather than a re-implementation that resembles it.

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

  // The free, local check ran above; the two counter checks fire together — they are
  // independent reads against the same store, and serialising them would double the
  // round-trip latency for nothing. All of it happens before the first token is
  // bought: a guard that fires after the model call is an invoice, not a guard.
  const [rate, budgetLeft] = await Promise.all([
    checkRateLimit(request),
    checkSpendCap(),
  ]);
  if (!rate.ok) return rate.response;
  if (!budgetLeft.ok) return budgetLeft.response;

  const code = input.code;

  // Resolved BEFORE the stream opens: modelFor throws by design on an unknown env
  // override, and a throw once the pipeline is running would land after the planner had
  // already been billed — discarding paid-for work over a typo that was knowable up
  // front. Fail while failing is still free, and while a status code is still possible.
  try {
    modelFor("specialist");
    modelFor("planner");
    modelFor("synthesizer");
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The stream can be torn down under us — the browser hangs up, and the controller
      // is closed before the pipeline notices. Every enqueue after that throws, INCLUDING
      // the one in the catch block below, which would replace the real error with a
      // TypeError and let it escape as an unhandled rejection. So writing is guarded
      // once, here, and a dead stream simply stops being written to.
      let open = true;

      // What this review has been billed so far, kept current as the events pass so
      // a pipeline that dies mid-run still settles what it saw. The reading itself is
      // the pipeline's (billedSoFar) — this route only holds the running number. The
      // daily cap tolerates the slack of a partial count; the layer that cannot be
      // under-reported to is the provider's own limit on the key.
      let billedUsd = 0;

      const send = (event: ReviewEvent) => {
        billedUsd = billedSoFar(event, billedUsd);

        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };

      try {
        await runReview(code, send, control.signal);
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

        // Recorded even when the pipeline failed or the client left: the money is
        // spent either way, and a cap that only counted the happy path would be
        // optimistic on exactly the days things went wrong.
        await recordSpend(billedUsd);

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
