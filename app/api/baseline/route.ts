import { completeText, OpenRouterError } from "@/lib/openrouter";
import { generalReviewMessages } from "@/lib/prompts/general-review";
import { readCode } from "@/lib/guards/input-cap";
import { checkRateLimit } from "@/lib/guards/rate-limit";
import { checkSpendCap, recordSpend } from "@/lib/guards/spend-cap";

// One generalist agent, one round trip, plain text back. No planner, no specialists,
// no synthesizer.
//
// This is the control group, and it is the reason the route still exists now that the
// pipeline does. The claim this project makes — that a planner, four specialists and a
// synthesizer produce a better review than one good prompt — is only a claim while
// there is something to compare against. Delete this and the claim becomes an
// assertion. It answers on the same wire, behind the same input cap, through the same
// model registry, so the comparison is between the designs and not between two
// different amounts of care.
//
// It shares the review endpoint's function ceiling for the same reason: a retried call
// can outlive the platform default (as low as 10s), which would kill it after the
// upstream work was already billed.
export const maxDuration = 300;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const input = await readCode(request);
  if (!input.ok) return input.response;

  // The same guards as the pipeline, because this route spends the same money. The
  // baseline being the cheaper path is not an exemption — an unguarded control group
  // is just the endpoint an abuser would pick.
  const [rate, budgetLeft] = await Promise.all([
    checkRateLimit(request),
    checkSpendCap(),
  ]);
  if (!rate.ok) return rate.response;
  if (!budgetLeft.ok) return budgetLeft.response;

  try {
    const { text, usage } = await completeText({
      role: "synthesizer",
      messages: generalReviewMessages(input.code),
      // Without this, a closed tab does not stop the upstream call: completeText has
      // no way to know the caller left, so a retried request runs to completion and
      // bills in full for an answer nobody will read. The pipeline route wires the
      // same request signal through for the same reason.
      signal: request.signal,
    });

    await recordSpend(usage.costUsd);

    return json({ review: text, costUsd: usage.costUsd }, 200);
  } catch (error) {
    // Upstream failures can echo prompt content back in their error text, and the
    // prompt contains the user's code. Log the detail, return a generic 502.
    console.error("[baseline] upstream failure", error);

    if (error instanceof OpenRouterError) {
      // The failed attempts were still billed; the daily total has to know.
      await recordSpend(error.usage.costUsd);
      return json({ error: "The model provider failed. Try again." }, 502);
    }
    return json({ error: "Something went wrong generating the review." }, 500);
  }
}
