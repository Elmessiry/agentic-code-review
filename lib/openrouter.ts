// Thin client for OpenRouter's Chat Completions API.
//
// OpenRouter exposes an OpenAI-compatible endpoint that proxies many vendors
// behind one URL. We call it with plain `fetch` (no SDK) on purpose: it keeps the
// wire format visible — which matters here, because this project cares about
// details an SDK hides (cache breakpoints, per-call cost, provider routing).

import { modelFor, type Role } from "@/lib/models";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// No single model call should take this long. Without it, a stalled upstream holds a
// serverless function open until the platform kills it — we pay for the wall time and
// the user watches a spinner that will never resolve.
//
// 45s, not 30s: a reasoning model given a dense rubric and a file to review genuinely
// took longer than thirty seconds, and timing it out was not protecting anyone from
// anything. The limit exists to catch a hang, not to hurry a model that is working.
const TIMEOUT_MS = 45_000;

// A cache breakpoint. Everything from the start of the request up to and including
// the block carrying this is cached; the next request that opens with a byte-identical
// prefix reads it back at roughly a tenth of the price.
//
// Only the explicit-cache vendors want this (Anthropic). The automatic-cache vendors
// (OpenAI, DeepSeek) cache the common prefix on their own and would reject or ignore
// the field, which is why lib/models.ts carries a `caching` mode and this is attached
// conditionally rather than always.
export type ContentBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
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

// A tool definition in OpenAI's function-calling shape. OpenRouter translates it
// to each vendor's native format, so the same definition works on Anthropic,
// OpenAI, DeepSeek and the rest.
export type Tool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type CallOptions = {
  role: Role;
  messages: ChatMessage[];
  signal?: AbortSignal;
  // When set, the model is FORCED to call this tool. Not offered it — forced.
  // That is the difference between structured output and a polite request for
  // JSON that the model is free to wrap in prose, apologise for, or ignore.
  tool?: Tool;
};

// Fires one chat completion and hands back the raw Response. Callers decide how
// to read it. The API key is read here, server-side only, and never leaves.
export function chatCompletion({
  role,
  messages,
  signal,
  tool,
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
      ...(tool
        ? {
            tools: [tool],
            // Naming the function (rather than "auto") removes the model's option
            // to answer in prose instead. It has exactly one legal move.
            tool_choice: { type: "function", function: { name: tool.function.name } },
          }
        : {}),
      provider: {
        // Strangers paste their code into this box. Pinning routing to
        // zero-data-retention endpoints means no provider on the path keeps it or
        // trains on it — the alternative is quietly donating other people's source
        // code to whichever vendor happened to be cheapest that second.
        zdr: true,
        // Not every provider behind a model id implements tool calling. Without
        // this, OpenRouter may route to one that silently ignores `tools` and
        // returns prose, which surfaces as a parse error somewhere far away.
        ...(tool ? { require_parameters: true } : {}),
      },
    }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
}

// Transient upstream failures. A provider rate-limiting us or briefly falling over
// is not a reason to fail a review the user is watching — but a 400 (our request is
// malformed) will fail identically every time, so retrying it just burns latency.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retries with exponential backoff and jitter. The jitter matters more than it looks:
// four specialists fan out simultaneously, so they hit any rate limit simultaneously,
// and a fixed backoff would have all four retry in lockstep and collide again.
async function withRetry(opts: CallOptions): Promise<Response> {
  let last: Response | Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await chatCompletion(opts);
      if (res.ok || !RETRYABLE.has(res.status)) return res;
      last = res;
    } catch (error) {
      // A network failure or an aborted timeout. Both are worth one more try.
      if (error instanceof Error && error.name === "AbortError") throw error;
      last = error as Error;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(2 ** attempt * 250 + Math.random() * 250);
    }
  }

  if (last instanceof Error) throw last;
  throw new OpenRouterError(last!.status, await last!.text());
}

// Forces a tool call and returns its arguments, already parsed.
//
// The model cannot decline: tool_choice names the function, so a well-behaved
// provider has one legal response shape. This still validates rather than trusts —
// `arguments` arrives as a JSON *string* the model generated token by token, and a
// model that runs out of output budget mid-object produces a truncated one.
export async function callTool<T>(opts: CallOptions & { tool: Tool }): Promise<{
  args: T;
  usage: Usage;
}> {
  const name = opts.tool.function.name;
  let last: Error | null = null;

  // Forcing a tool call is not a guarantee, only a very strong hint, and this was
  // measured rather than assumed: a reasoning model answered with its chain of thought
  // and no tool call at all, despite tool_choice naming the function. It is a transient
  // model failure of exactly the kind a retry fixes — so the parse lives INSIDE the
  // retry loop rather than after it. Retrying only on the HTTP status would have left
  // this one failing permanently on a 200.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await withRetry(opts);

    if (!res.ok) {
      throw new OpenRouterError(res.status, await res.text());
    }

    const json = await res.json();
    const call = json?.choices?.[0]?.message?.tool_calls?.[0];

    if (!call) {
      last = new OpenRouterError(
        502,
        `model answered without calling ${name}: ${JSON.stringify(json?.choices?.[0]?.message ?? json)}`,
      );
    } else {
      try {
        // `arguments` is a JSON *string* the model generated token by token, so a model
        // that ran out of output budget mid-object hands back a truncated one.
        return { args: JSON.parse(call.function.arguments) as T, usage: readUsage(json) };
      } catch {
        last = new OpenRouterError(
          502,
          `${name} returned unparseable arguments: ${call.function.arguments}`,
        );
      }
    }

    if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 250 + Math.random() * 250);
  }

  throw last!;
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
