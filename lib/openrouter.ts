// Thin client for OpenRouter's Chat Completions API.
//
// OpenRouter exposes one endpoint, speaking the de facto standard chat-completions
// wire format, that proxies many vendors behind one URL. We call it with plain
// `fetch` (no SDK) on purpose: it keeps the wire format visible — which matters
// here, because this project cares about details an SDK hides (cache breakpoints,
// per-call cost, provider routing).

import { modelFor, type Role } from "@/lib/models";
import { sseEvents } from "@/lib/sse";
import { FieldDecoder } from "@/lib/partial-json";

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
  // Ask for the response token by token. Only the synthesizer wants this: it is the
  // one call whose output a human sits and reads, so it is the one call where the
  // time to the FIRST word matters more than the time to the last.
  stream?: boolean;
  // Overrides the default ceiling. A streamed call is held open for as long as the
  // model keeps writing, so it needs a longer leash than a request/response call —
  // see STREAM_TIMEOUT_MS.
  timeoutMs?: number;
};

// Fires one chat completion and hands back the raw Response. Callers decide how
// to read it. The API key is read here, server-side only, and never leaves.
export function chatCompletion({
  role,
  messages,
  signal,
  tool,
  stream,
  timeoutMs,
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
      ...(stream
        ? {
            stream: true,
            // Without this, a streamed response carries no usage at all and every
            // streamed call would report a cost of zero — which is worse than no
            // figure, because it looks like one. Verified against the live API: with
            // it, the final chunk before [DONE] carries the same usage object a
            // non-streamed response returns, `cost` in real dollars included.
            usage: { include: true },
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
    // Two ways this call can be cut short, and it must obey both. The timeout catches a
    // hung upstream. The caller's signal is the user closing the tab — and an upstream
    // call nobody is waiting for is one nobody should be paying for either. Passing only
    // the caller's signal (the previous behaviour) silently discarded the timeout.
    signal: AbortSignal.any([
      AbortSignal.timeout(timeoutMs ?? TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]),
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

// The zero value, in one place. It was defined twice — once here and once in
// lib/pipeline/specialists.ts — which is one definition too many: adding a field to
// Usage would have compiled cleanly with only one of them updated, and the other would
// have quietly produced an undefined in a cost total.
export const ZERO_USAGE: Usage = {
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

// How a caller turns one successful (2xx) response into its value.
//
// It reports what the attempt was BILLED as well as what it produced, and it does so
// on the failure path too: a `consume` that gives up on a malformed body throws an
// OpenRouterError carrying the usage it had already read. Otherwise a retried call
// would forget the money the failed attempt cost, and every cost figure downstream
// would be optimistic on exactly the requests that went wrong.
type Consume<T> = (res: Response) => Promise<{ value: T; usage: Usage }>;

// The one retry policy every model call goes through.
//
// Retryable, and all measured in this codebase rather than assumed: transient HTTP
// statuses, network failures, the timeout, and — the surprising one — a 200 whose
// payload is unusable, because a model told to call a tool sometimes answers with its
// chain of thought instead, and a model that runs out of output budget mid-object
// hands back truncated JSON. `consume` reads the response and throws to request a
// retry; everything else is one loop with one budget and jittered backoff (four
// specialists hit a rate limit simultaneously, so a fixed backoff would have them
// retry in lockstep and collide again).
//
// `committed` is the veto a streaming caller needs. Once the first token has been
// forwarded to the browser, a retry is no longer a retry — it is a second, different
// review arriving on top of the half-written one. So a caller that has already shown
// the user output declares itself committed, and the loop stops even for a failure it
// would otherwise happily retry. A streamed call that dies before its first token,
// though, is invisible to the user and retries like anything else.
async function completeWithRetry<T>(
  opts: CallOptions,
  consume: Consume<T>,
  committed: () => boolean = () => false,
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
        const read = await consume(res);
        addUsage(usage, read.usage);
        return { value: read.value, usage };
      }
    } catch (error) {
      // A network failure, the timeout, or a body `consume` refused. All three are
      // worth another attempt — but a billed one still has to be paid for.
      if (error instanceof OpenRouterError) addUsage(usage, error.usage);
      last = error as Error;
    }

    // The caller is gone — the tab closed, or the pipeline ran out of budget. Retrying
    // now spends money on an answer with no recipient, and an aborted fetch would fail
    // identically on every attempt anyway.
    if (opts.signal?.aborted) break;

    // Anything already streamed to the user is history. Do not overwrite it.
    if (committed()) break;

    if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 250 + Math.random() * 250);
  }

  const failure =
    last instanceof OpenRouterError
      ? last
      : new OpenRouterError(0, `${last!.name}: ${last!.message}`);
  failure.usage = usage;
  throw failure;
}

// Reads a whole JSON body, records what it cost, and hands it to `extract`. Wrapping
// the extraction failure in an OpenRouterError — rather than letting it fly bare — is
// what carries the billed usage of the doomed attempt back to the retry loop.
function jsonBody<T>(extract: (json: unknown) => T): Consume<T> {
  return async (res) => {
    const json = await res.json();
    const usage = readUsage(json);

    try {
      return { value: extract(json), usage };
    } catch (error) {
      const failure =
        error instanceof OpenRouterError
          ? error
          : new OpenRouterError(
              502,
              `${(error as Error).name}: ${(error as Error).message}`,
            );
      failure.usage = usage;
      throw failure;
    }
  };
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

  const { value, usage } = await completeWithRetry<T>(
    opts,
    jsonBody((json) => {
      const message = (json as { choices?: { message?: unknown }[] })?.choices?.[0]
        ?.message as { tool_calls?: { function: { arguments: string } }[] } | undefined;
      const call = message?.tool_calls?.[0];

      if (!call) {
        throw new OpenRouterError(
          502,
          `model answered without calling ${name}: ${JSON.stringify(message ?? json)}`,
        );
      }

      return parseArgs<T>(call.function.arguments, name);
    }),
  );

  return { args: value, usage };
}

// The forced tool call's arguments arrive as a JSON string, and a model that runs out
// of output budget mid-object hands back a truncated one. Parsing it is therefore a
// place that fails, not a formality.
function parseArgs<T>(raw: string, name: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new OpenRouterError(502, `${name} returned unparseable arguments: ${raw}`);
  }
}

// Reads a non-streaming completion: the assistant's text plus what it cost. Goes
// through the same retry policy as the tool calls — the generalist route sees the
// same transient 429s the specialists do, and for a while it was the only call path
// with no resilience at all, which quietly biased any comparison against it.
export async function completeText(opts: CallOptions): Promise<{
  text: string;
  usage: Usage;
}> {
  const { value, usage } = await completeWithRetry<string>(
    opts,
    jsonBody((json) => {
      const text = (
        (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
          ?.message as { content?: unknown } | undefined
      )?.content;

      if (typeof text !== "string" || text.length === 0) {
        throw new OpenRouterError(502, `no content in response: ${JSON.stringify(json)}`);
      }
      return text;
    }),
  );

  return { text: value, usage };
}

// A streamed call is held open for as long as the model keeps writing, so it needs a
// longer leash than a request/response call: the 45s ceiling that catches a hung
// specialist would guillotine a synthesizer that is simply being thorough. This is
// still a hang detector, not a deadline — nothing legitimate takes two minutes.
const STREAM_TIMEOUT_MS = 120_000;

// Streams a forced tool call, decoding ONE of its string fields into prose as it
// arrives, and returns the parsed arguments once the call completes.
//
// The problem this solves: the synthesizer has to do two things that normally fight.
// It must return structure — deduped findings, their sources, a verdict — which means
// a forced tool call. And its summary must stream, because it is the one output a
// human sits and reads, and a spinner for fifteen seconds is a worse product than
// words appearing. The usual workaround is two calls, one structured and one prose,
// which doubles the latency and the bill and lets the two disagree with each other.
//
// They do not actually fight, because a tool call's `arguments` stream too — as raw
// JSON fragments, split anywhere at all (verified against the live API: one chunk
// ended mid-word at `{"summary": "The code buil`). So if `streamField` is the FIRST
// property in the tool's schema, its value can be decoded out of a JSON object that
// is still being written, forwarded as it grows, and the completed buffer parsed for
// the structure at the end. One call. Streamed prose, validated structure.
//
// The cost of that trick is a real one and worth naming: the model commits to its
// summary BEFORE it writes the findings it is summarising, because that is the order
// the schema forces. It is affordable here only because synthesis is re-ranking work
// on findings it was handed, not discovery — nothing in the summary depends on a
// conclusion the model has not reached yet.
export async function streamTool<T>(
  opts: CallOptions & { tool: Tool; streamField: string },
  onDelta: (text: string) => void,
): Promise<{ args: T; usage: Usage }> {
  const name = opts.tool.function.name;
  let started = false;

  const { value, usage } = await completeWithRetry<T>(
    { ...opts, stream: true, timeoutMs: opts.timeoutMs ?? STREAM_TIMEOUT_MS },
    async (res) => {
      const usage: Usage = { ...ZERO_USAGE };
      let args = "";
      const field = new FieldDecoder(opts.streamField);

      try {
        for await (const event of sseEvents(res)) {
          // OpenRouter can report a failure inside a 200 stream, once the connection
          // is already open and the headers say everything is fine.
          const error = (event as { error?: { message?: string; code?: number } }).error;
          if (error) {
            throw new OpenRouterError(error.code ?? 502, error.message ?? "stream error");
          }

          const chunk = event as {
            usage?: unknown;
            choices?: {
              delta?: { tool_calls?: { function?: { arguments?: string } }[] };
            }[];
          };

          // Usage rides the final chunk, not the first — so it is read every time and
          // whatever arrived last is what the call cost.
          if (chunk.usage) Object.assign(usage, readUsage(chunk));

          const fragment =
            chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments;
          if (!fragment) continue;

          args += fragment;

          // The decoder is fed the fragment, not the whole buffer: each character is
          // decoded once instead of the accumulated string being re-parsed per chunk.
          const text = field.push(fragment);
          if (text) {
            started = true;
            onDelta(text);
          }
        }
      } catch (error) {
        // Whatever the stream managed to bill before it broke is still owed.
        const failure =
          error instanceof OpenRouterError
            ? error
            : new OpenRouterError(
                0,
                `${(error as Error).name}: ${(error as Error).message}`,
              );
        failure.usage = usage;
        throw failure;
      }

      try {
        return { value: parseArgs<T>(args, name), usage };
      } catch (error) {
        (error as OpenRouterError).usage = usage;
        throw error;
      }
    },
    // Committed the moment a word has reached the browser. A retry after that would
    // not repair the review, it would append a second one to the half-written first.
    () => started,
  );

  return { args: value, usage };
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
