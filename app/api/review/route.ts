import { completeText, OpenRouterError } from "@/lib/openrouter";
import { generalReviewMessages } from "@/lib/prompts/general-review";
import { readCode } from "@/lib/guards/input-cap";

// Day 1: one generalist agent, one round trip, plain text back.
//
// This is the control group. When the pipeline lands, the question worth asking is
// whether four specialists and a synthesizer actually beat one good prompt — and
// that stays answerable only while the one good prompt is still here.

// A retried call can run past the platform's default function timeout (as low as
// 10s); see app/api/specialists/route.ts for the reasoning behind the number.
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

  try {
    const { text, usage } = await completeText({
      role: "synthesizer",
      messages: generalReviewMessages(input.code),
    });

    return json({ review: text, costUsd: usage.costUsd }, 200);
  } catch (error) {
    // Upstream failures can echo prompt content back in their error text, and the
    // prompt contains the user's code. Log the detail, return a generic 502.
    console.error("[review] upstream failure", error);

    if (error instanceof OpenRouterError) {
      return json({ error: "The model provider failed. Try again." }, 502);
    }
    return json({ error: "Something went wrong generating the review." }, 500);
  }
}
