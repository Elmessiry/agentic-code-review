// Thin client for OpenRouter's Chat Completions API.
//
// OpenRouter exposes an OpenAI-compatible endpoint that proxies many vendors
// behind one URL. We call it with plain `fetch` (no SDK) on purpose: it keeps the
// wire format visible — which matters here, because this project cares about
// details an SDK hides (cache breakpoints, per-call cost, provider routing).
//
// Ported from pr1's lib/openrouter.ts and extended.

import { modelFor, type Role } from "@/lib/models";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// No single model call should take this long. Without it, a stalled upstream
// holds a serverless function open until the platform kills it — we pay for the
// wall time and the user watches a spinner that will never resolve.
const TIMEOUT_MS = 30_000;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// What a call cost and how much of it was served from cache. OpenRouter reports
// cost in real dollars, so nothing here is estimated from token counts — the
// spend cap in lib/guards counts actual money.
export type Usage = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
};

// Thrown when OpenRouter (or the vendor behind it) refuses the call. The message
// is for our logs, never for the browser: upstream errors can echo back prompt
// content, and the prompt contains the user's code.
export class OpenRouterError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`OpenRouter returned ${status}: ${detail}`);
    this.name = "OpenRouterError";
  }
}

type CallOptions = {
  role: Role;
  messages: ChatMessage[];
  signal?: AbortSignal;
};

// Fires one chat completion and hands back the raw Response. Callers decide how
// to read it. The API key is read here, server-side only, and never leaves.
export function chatCompletion({
  role,
  messages,
  signal,
}: CallOptions): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // A missing key is a deploy mistake, not a user error — fail loud on the
    // server. This throw never reaches the browser.
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const model = modelFor(role);

  return fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Attribution on OpenRouter's public leaderboard. Harmless, and free advertising.
      "HTTP-Referer": "https://codereview.elmessiry.tech",
      "X-Title": "Agentic Code Review",
    },
    body: JSON.stringify({
      model: model.id,
      messages,
      // Strangers paste their code into this box. Pinning routing to
      // zero-data-retention endpoints means no provider on the path keeps it or
      // trains on it — the alternative is quietly donating other people's source
      // code to whichever vendor happened to be cheapest that second.
      provider: { zdr: true },
    }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
}

// Reads a non-streaming completion: the assistant's text plus what it cost.
export async function completeText(opts: CallOptions): Promise<{
  text: string;
  usage: Usage;
}> {
  const res = await chatCompletion(opts);

  if (!res.ok) {
    throw new OpenRouterError(res.status, await res.text());
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    throw new OpenRouterError(502, `no content in response: ${JSON.stringify(json)}`);
  }

  return { text, usage: readUsage(json) };
}

// OpenRouter attaches usage to every response. `cost` is what it actually charged
// us; `prompt_tokens_details.cached_tokens` is how much of the prompt it served
// from cache. Both are load-bearing: the first funds the spend cap, the second is
// the only honest way to know whether the caching strategy is working.
export function readUsage(json: unknown): Usage {
  const usage = (json as { usage?: Record<string, unknown> })?.usage ?? {};
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

  return {
    costUsd: num(usage.cost),
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    cachedTokens: num(details.cached_tokens),
  };
}
