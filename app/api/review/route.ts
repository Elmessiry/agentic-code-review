import { completeText, OpenRouterError } from "@/lib/openrouter";
import { generalReviewMessages } from "@/lib/prompts/general-review";

// Day 1: one generalist agent, one round trip, plain text back. No planner, no
// specialists, no synthesizer — those arrive over the next three days, and this
// route becomes the streaming pipeline that orchestrates them.

// Every character here is multiplied by however many specialists end up running,
// so the cap is a cost control, not a UX preference. ~20k characters is a long
// file and well short of any model's context limit.
const MAX_CODE_CHARS = 20_000;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const code = (body as { code?: unknown })?.code;

  if (typeof code !== "string" || code.trim().length === 0) {
    return json({ error: "Paste some code to review." }, 400);
  }

  if (code.length > MAX_CODE_CHARS) {
    return json(
      {
        error: `That snippet is ${code.length.toLocaleString()} characters. The limit is ${MAX_CODE_CHARS.toLocaleString()} — review a single file or function instead.`,
      },
      413,
    );
  }

  try {
    const { text, usage } = await completeText({
      role: "synthesizer",
      messages: generalReviewMessages(code),
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
