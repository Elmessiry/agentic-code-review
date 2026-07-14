import { OpenRouterError } from "@/lib/openrouter";
import { overrideNotes, plan } from "@/lib/pipeline/plan";
import { readCode } from "@/lib/guards/input-cap";

// Day 2: the planner alone, so its decision can be inspected on its own before
// anything is wired behind it.
//
// This route is temporary. On Day 4 the whole pipeline collapses into a single
// streaming POST /api/review, and this endpoint gets deleted — three public routes
// that each call a model are three surfaces to rate-limit and cap, for no benefit
// once the client stops orchestrating.

// A retried planner call can run past the platform's default function timeout (as low
// as 10s); see app/api/specialists/route.ts for the reasoning behind the number.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const input = await readCode(request);
  if (!input.ok) return input.response;

  try {
    const { plan: decision, usage } = await plan(input.code);

    return Response.json(
      {
        ...decision,
        overrides: overrideNotes(input.code),
        costUsd: usage.costUsd,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[plan] failed", error);

    if (error instanceof OpenRouterError) {
      return Response.json(
        { error: "The planner could not be reached. Try again." },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { error: "Something went wrong planning the review." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
