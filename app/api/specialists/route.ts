import { readCode } from "@/lib/guards/input-cap";
import { overrideNotes, plan } from "@/lib/pipeline/plan";
import { fanOut } from "@/lib/pipeline/specialists";
import { approxTokens } from "@/lib/prompts/shared-prefix";
import { modelFor } from "@/lib/models";
import type { ReviewResponse } from "@/lib/pipeline/schema";

// Day 3: plan, then run the selected specialists in parallel.
//
// Temporary, like /api/plan. On Day 4 the synthesizer lands and all of this collapses
// into a single streaming POST /api/review — three public routes that each call a model
// are three surfaces to rate-limit and cap, for no benefit once the client stops
// orchestrating.

export async function POST(request: Request): Promise<Response> {
  const input = await readCode(request);
  if (!input.ok) return input.response;

  try {
    const { plan: decision, usage: planUsage } = await plan(input.code);
    const fan = await fanOut(decision.agents, input.code);

    const spec = modelFor("specialist");
    const prefixTokens = approxTokens(input.code);

    // Annotated, so that dropping a field the UI reads is a build error.
    const payload: ReviewResponse = {
      plan: {
        ...decision,
        overrides: overrideNotes(input.code),
        // The planner's own cost rides with the planner's own decision. Splitting it
        // out into the totals below and leaving the card to guess is how this shipped
        // an undefined.toFixed() the first time.
        costUsd: planUsage.costUsd,
      },
      results: fan.results.map((r) => ({
        specialist: r.specialist,
        findings: r.findings,
        droppedLineRefs: r.droppedLineRefs,
      })),
      failures: fan.failures,
      cost: {
        planUsd: planUsage.costUsd,
        specialistsUsd: fan.costUsd,
        totalUsd: planUsage.costUsd + fan.costUsd,
      },
      // Everything needed to tell whether the caching strategy actually worked, rather
      // than whether it was configured. cachedTokens of 0 across a multi-specialist run
      // means the prefix is not being reused, whatever the code believes.
      cache: {
        mode: spec.caching,
        model: spec.id,
        prefixTokens,
        // The floor below which a cache breakpoint is silently ignored. If the prefix
        // is under it, caching is off no matter what the request said.
        minCacheTokens: spec.minCacheTokens,
        clearsFloor: prefixTokens >= spec.minCacheTokens,
        cachedTokens: fan.cachedTokens,
        inputTokens: fan.inputTokens,
        hitRate: fan.inputTokens > 0 ? fan.cachedTokens / fan.inputTokens : 0,
      },
    };

    return Response.json(payload, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[specialists] failed", error);
    return Response.json(
      { error: "The review could not be completed. Try again." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
