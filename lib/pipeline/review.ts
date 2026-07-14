import { modelFor } from "@/lib/models";
import { OpenRouterError } from "@/lib/openrouter";
import { approxTokens } from "@/lib/prompts/shared-prefix";
import { mergeDeterministically } from "./merge";
import { overrideNotes, plan } from "./plan";
import { fanOut } from "./specialists";
import { synthesize } from "./synthesize";
import type { ReviewEvent } from "./schema";

// The pipeline itself: guard's already done, so this is tripwire → plan → specialists →
// synthesize, emitting an event at every step.
//
// It lives here rather than in the route for one reason that matters more than tidiness:
// the eval harness has to score THE PIPELINE, not a re-implementation of it that happens
// to look similar. An eval that reaches for `plan()` and `fanOut()` and stitches them
// together itself is grading its own copy of the orchestration — it cannot catch a bug in
// the order the stages run, in what gets skipped, or in how the totals are added up,
// because it does not use any of that. So the route and the harness call the same
// function, and the only thing that differs is what they do with the events.
//
// Emitting rather than returning is what makes that possible. The route turns each event
// into an SSE frame; the harness collects them into a transcript and asserts against it.

export type Emit = (event: ReviewEvent) => void;

export async function runReview(
  code: string,
  emit: Emit,
  signal?: AbortSignal,
): Promise<void> {
  const spec = modelFor("specialist");

  const { plan: decision, usage: planUsage } = await plan(code, signal);

  emit({
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
      onStart: (specialist) => emit({ type: "specialist_start", specialist }),
      onOutcome: (outcome) =>
        outcome.ok
          ? emit({
              type: "specialist_done",
              specialist: outcome.result.specialist,
              findings: outcome.result.findings,
              droppedLineRefs: outcome.result.droppedLineRefs,
            })
          : emit({
              type: "specialist_error",
              specialist: outcome.failure.specialist,
              error: outcome.failure.error,
            }),
    },
    signal,
  );

  const synthesisUsd = await runSynthesis(
    code,
    decision.agents.length,
    fan,
    signal,
    emit,
  );

  const prefixTokens = approxTokens(code);

  emit({
    type: "done",
    cost: {
      planUsd: planUsage.costUsd,
      specialistsUsd: fan.costUsd,
      synthesisUsd,
      totalUsd: planUsage.costUsd + fan.costUsd + synthesisUsd,
    },
    // Everything needed to tell whether the caching strategy actually worked, rather than
    // whether it was configured. A cachedTokens of 0 across a multi-specialist run means
    // the prefix is not being reused, whatever the code believes.
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
}

// The synthesis step, and the two cases where the right move is not to take it.
//
// Synthesis is the most expensive call in the pipeline by a distance — measured at 70% of
// a review, roughly 2.5x what all the specialists cost together. Paying it to announce
// that nothing is wrong is the worst trade in the system. There is nothing to merge,
// nothing to rank, and no disagreement to resolve, so the verdict is written here instead,
// for free:
//
//   nobody was selected — the planner judged that no lens was worth running. That is a
//   real answer, and it still deserves a verdict rather than an empty page.
//
//   everybody ran and nobody found anything — an approval, arrived at honestly.
//
// The failure case is deliberately NOT folded into either shortcut. If a specialist died,
// an empty result set is not a clean bill of health, it is a review with a hole in it —
// and the synthesizer is the thing that knows how to say so. An outage must never be able
// to come out of this function looking like an approval.
async function runSynthesis(
  code: string,
  selected: number,
  fan: Awaited<ReturnType<typeof fanOut>>,
  signal: AbortSignal | undefined,
  emit: Emit,
): Promise<number> {
  const approve = (text: string) => {
    emit({ type: "synthesis_delta", text });
    emit({ type: "synthesis_done", findings: [], verdict: "approve" });
    return 0;
  };

  if (selected === 0) {
    return approve(
      "The planner read this code and found no lens worth running on it — nothing here is exposed to an attacker, on a hot path, hard to follow, or hard to test. No specialist ran, so this review cost the planner alone.",
    );
  }

  // Every selected specialist failed. Nothing ran, so nothing can be concluded — and
  // saying "approve" here would be inventing a clean bill of health out of an outage. The
  // failure cards are already on the page; they are the honest report.
  if (fan.results.length === 0) return 0;

  const foundSomething = fan.results.some((r) => r.findings.length > 0);
  const everyoneReported = fan.failures.length === 0;

  if (!foundSomething && everyoneReported) {
    return approve(
      "Every specialist that ran read this code and found nothing worth raising. There was nothing to merge, rank or disagree about, so no synthesis call was made — this review cost what the specialists cost.",
    );
  }

  // How much of the summary the user has already read. A synthesizer that dies mid-sentence
  // leaves half a paragraph on the screen, and the fallback has to acknowledge that rather
  // than start a second one underneath it.
  let streamed = 0;

  try {
    const { synthesis, usage } = await synthesize(
      code,
      fan.results,
      fan.failures.map((f) => f.specialist),
      (text) => {
        streamed += text.length;
        emit({ type: "synthesis_delta", text });
      },
      signal,
    );

    emit({
      type: "synthesis_done",
      findings: synthesis.findings,
      verdict: synthesis.verdict,
    });

    return usage.costUsd;
  } catch (error) {
    // An abandoned review is not a degraded one. If the user closed the tab or the budget
    // ran out, there is nobody to hand a fallback to, and pretending otherwise would send
    // a review into a stream that has already gone.
    if (signal?.aborted) throw error;

    // The synthesizer failed, and it is the last agent in the pipeline — so failing here
    // used to fail the whole review, throwing away specialist reports that were already
    // read, already validated, and already billed. That was the same mistake the fan-out
    // is explicitly designed to prevent, left standing in front of the most expensive
    // agent in the system. Measured on a real run: the provider returned unparseable tool
    // arguments and a complete, correct set of four security findings died with it.
    //
    // So the findings are merged mechanically and the review stands. It is worse than a
    // synthesized one and it says so.
    console.error("[review] synthesis failed — merging deterministically instead", error);

    const merged = mergeDeterministically(fan.results);

    emit({
      type: "synthesis_delta",
      text:
        (streamed > 0 ? " …\n\n" : "") +
        "The synthesizer did not finish, so these findings were merged mechanically: " +
        "duplicates on the same line were combined and the highest severity anyone gave " +
        "was kept. Nothing below has been re-ranked, reconciled or judged by a model — " +
        "read the severities as the specialists reported them.",
    });

    emit({
      type: "synthesis_done",
      findings: merged.findings,
      verdict: merged.verdict,
    });

    // The failed attempts were still billed, and a cost figure that quietly dropped them
    // would be optimistic on exactly the reviews that went wrong.
    return error instanceof OpenRouterError ? error.usage.costUsd : 0;
  }
}
