// Thin client for OpenRouter's Chat Completions API.
//
// OpenRouter exposes one endpoint, speaking the de facto standard chat-completions
// wire format, that proxies many vendors behind one URL. We call it with plain
// `fetch` (no SDK) on purpose: it keeps the wire format visible — which matters
// here, because this project cares about details an SDK hides (cache breakpoints,
// per-call cost, provider routing).

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
// Only explicit-cache models want this. Automatic-cache models cache the common
// prefix on their own and would ignore or reject the field — which caching mode a
// model uses lives in lib/models.ts, and this is attached conditionally from there.
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
//
// `usage` carries whatever the failed call sequence was BILLED before it gave up.
// A retried attempt that returned a malformed payload still cost real money, and a
// caller that reports spend has to be able to count it — dropping it here would make
// every cost figure downstream quietly optimistic.
export class OpenRouterError extends Error {
  usage: Usage = { costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`OpenRouter returned ${status}: ${detail}`);
    this.name = "OpenRouterError";
  }
}

// A tool definition in the de facto standard function-calling shape. OpenRouter
// translates it to each vendor's native format, so one definition works everywhere.
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

// Total upstream calls for one logical request, across EVERY failure mode. The first
// version of this file had two nested retry loops — one for HTTP failures, one for
// malformed tool calls — each with its own budget of 3, which multiplied to a worst
// case of nine billed calls and several minutes of wall time for a single specialist.
// Nobody reading "MAX_ATTEMPTS = 3" would have guessed nine. One loop, one budget.
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ZERO_USAGE: Usage = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
};

function addUsage(into: Usage, from: Usage): void {
  into.costUsd += from.costUsd;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cachedTokens += from.cachedTokens;
}

// The one retry policy every model call goes through.
//
// Retryable, and all measured in this codebase rather than assumed: transient HTTP
// statuses, network failures, the 45s timeout, and — the surprising one — a 200 whose
// payload is unusable, because a model told to call a tool sometimes answers with its
// chain of thought instead, and a model that runs out of output budget mid-object
// hands back truncated JSON. `extract` pulls the caller's value out of the response
// body and throws to request a retry; everything else is one loop with one budget and
// jittered backoff (four specialists hit a rate limit simultaneously, so a fixed
// backoff would have them retry in lockstep and collide again).
//
// Usage is accumulated across EVERY parsed response, not just the winning one. An
// attempt that got billed and then failed to parse still cost money, and the total
// this returns — or attaches to the error it throws — is what the caller reports as
// spend. Counting only the successful attempt would understate every retried call.
async function completeWithRetry<T>(
  opts: CallOptions,
  extract: (json: unknown) => T,
): Promise<{ value: T; usage: Usage }> {
  const usage: Usage = { ...ZERO_USAGE };
  let last: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await chatCompletion(opts);

      if (!res.ok) {
        last = new OpenRouterError(res.status, await res.text());
        // A non-retryable status fails identically every time — stop paying to ask.
        if (!RETRYABLE.has(res.status)) break;
      } else {
        const json = await res.json();
        // Billed the moment it exists, parseable or not.
        addUsage(usage, readUsage(json));

        try {
          return { value: extract(json), usage };
        } catch (error) {
          last = error as Error;
        }
      }
    } catch (error) {
      // Network failure or the timeout. Both transient, both worth another try.
      last = error as Error;
    }

    if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 250 + Math.random() * 250);
  }

  const failure =
    last instanceof OpenRouterError
      ? last
      : new OpenRouterError(0, `${last!.name}: ${last!.message}`);
  failure.usage = usage;
  throw failure;
}

// Forces a tool call and returns its arguments, already parsed.
//
// The model cannot decline: tool_choice names the function, so a well-behaved
// provider has one legal response shape. This still validates rather than trusts.
export async function callTool<T>(opts: CallOptions & { tool: Tool }): Promise<{
  args: T;
  usage: Usage;
}> {
  const name = opts.tool.function.name;

  const { value, usage } = await completeWithRetry<T>(opts, (json) => {
    const message = (json as { choices?: { message?: unknown }[] })?.choices?.[0]
      ?.message as { tool_calls?: { function: { arguments: string } }[] } | undefined;
    const call = message?.tool_calls?.[0];

    if (!call) {
      throw new OpenRouterError(
        502,
        `model answered without calling ${name}: ${JSON.stringify(message ?? json)}`,
      );
    }

    try {
      return JSON.parse(call.function.arguments) as T;
    } catch {
      throw new OpenRouterError(
        502,
        `${name} returned unparseable arguments: ${call.function.arguments}`,
      );
    }
  });

  return { args: value, usage };
}

// Reads a non-streaming completion: the assistant's text plus what it cost. Goes
// through the same retry policy as the tool calls — the generalist route sees the
// same transient 429s the specialists do, and for a while it was the only call path
// with no resilience at all, which quietly biased any comparison against it.
export async function completeText(opts: CallOptions): Promise<{
  text: string;
  usage: Usage;
}> {
  const { value, usage } = await completeWithRetry<string>(opts, (json) => {
    const text = (
      (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
        ?.message as { content?: unknown } | undefined
    )?.content;

    if (typeof text !== "string" || text.length === 0) {
      throw new OpenRouterError(502, `no content in response: ${JSON.stringify(json)}`);
    }
    return text;
  });

  return { text: value, usage };
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
