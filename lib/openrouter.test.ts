import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { callTool, streamTool, OpenRouterError, type Tool } from "./openrouter";

// The retry loop's contract, pinned against a mocked wire. One loop, one budget:
// transient HTTP, malformed 200s, and mid-stream deaths all count against the same
// three attempts, usage accumulates across every BILLED attempt and travels on the
// error when the call ultimately fails, and a stream that has reached the browser
// is never retried. The regression each of these guards against is written into the
// retry loop's own comments — nested budgets multiplying 3 into 9, optimistic cost
// totals, a second review appended to a half-written one.

const realFetch = globalThis.fetch;

let fetchCalls = 0;

// Queues one Response factory per expected upstream call. A call past the end of the
// queue fails loudly: the queue length IS the budget under test, and a fourth fetch
// after three queued failures is exactly the nested-budget regression.
function upstreamReplies(replies: (() => Response)[]): void {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    const reply = replies[fetchCalls];
    fetchCalls += 1;
    if (!reply) {
      throw new Error(`unexpected upstream call #${fetchCalls}: the retry budget leaked`);
    }
    return reply();
  }) as typeof fetch;
}

const http = (status: number) => () => new Response("upstream said no", { status });

// A well-formed forced-tool-call response, with the usage OpenRouter attaches.
function toolCallReply(args: unknown, usage: Record<string, unknown>): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [{ function: { arguments: JSON.stringify(args) } }],
            },
          },
        ],
        usage,
      }),
      { status: 200 },
    );
}

// An SSE body whose chunk boundaries are exactly where the test places them.
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const sseEvent = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const fragmentEvent = (fragment: string, extra: Record<string, unknown> = {}) =>
  sseEvent({
    choices: [{ delta: { tool_calls: [{ function: { arguments: fragment } }] } }],
    ...extra,
  });

const REVIEW_TOOL: Tool = {
  type: "function",
  function: {
    name: "write_review",
    description: "a forced tool call for the tests to exercise",
    parameters: { type: "object", properties: { summary: { type: "string" } } },
  },
};

const MESSAGES = [{ role: "user" as const, content: "review this" }];

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

test("every failure mode spends the same budget: 500, billed malformed 200, 500 is exactly three fetches, and the malformed attempt's cost survives on the error", async () => {
  upstreamReplies([
    http(500),
    // A 200 whose payload is unusable: the model answered with prose instead of the
    // forced tool call. It still cost real money, and that money must not be lost.
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "chain of thought instead of a tool call" } }],
          usage: { cost: 0.01, prompt_tokens: 120, completion_tokens: 40 },
        }),
        { status: 200 },
      ),
    http(500),
  ]);

  await assert.rejects(
    callTool({ role: "specialist", messages: MESSAGES, tool: REVIEW_TOOL }),
    (error: unknown) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.usage.costUsd, 0.01);
      assert.equal(error.usage.inputTokens, 120);
      assert.equal(error.usage.outputTokens, 40);
      return true;
    },
  );

  // Three, not four: HTTP failures and malformed bodies share ONE budget. A fourth
  // fetch here is the nested-retry regression coming back.
  assert.equal(fetchCalls, 3);
});

test("a 400 fails identically every time, so it is not retried: one fetch, immediate failure", async () => {
  upstreamReplies([http(400)]);

  await assert.rejects(
    callTool({ role: "specialist", messages: MESSAGES, tool: REVIEW_TOOL }),
    (error: unknown) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.status, 400);
      return true;
    },
  );

  assert.equal(fetchCalls, 1);
});

test("a 429 followed by a good response succeeds, and usage counts only the billed attempt", async () => {
  upstreamReplies([
    http(429),
    toolCallReply(
      { verdict: "approve" },
      {
        cost: 0.02,
        prompt_tokens: 200,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 50 },
      },
    ),
  ]);

  const { args, usage } = await callTool<{ verdict: string }>({
    role: "specialist",
    messages: MESSAGES,
    tool: REVIEW_TOOL,
  });

  assert.equal(args.verdict, "approve");
  // The rejected 429 was never billed; the total is the successful attempt, exactly.
  assert.deepEqual(usage, {
    costUsd: 0.02,
    inputTokens: 200,
    outputTokens: 20,
    cachedTokens: 50,
  });
  assert.equal(fetchCalls, 2);
});

test("an abort seen between attempts stops the loop: nobody is waiting, so nothing more is fetched", async () => {
  const controller = new AbortController();

  upstreamReplies([
    () => {
      // The tab closes while the first attempt is in flight.
      controller.abort();
      return new Response("upstream said no", { status: 500 });
    },
    // Never reached — queued so that a retry-past-the-abort would surface as a
    // fetch-count mismatch rather than an "unexpected call" throw.
    http(500),
    http(500),
  ]);

  await assert.rejects(
    callTool({
      role: "specialist",
      messages: MESSAGES,
      tool: REVIEW_TOOL,
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.status, 500);
      return true;
    },
  );

  assert.equal(fetchCalls, 1);
});

test("a stream that has reached the browser is never retried: one fetch, and the billed usage rides the error", async () => {
  upstreamReplies([
    () =>
      new Response(
        sseBody([
          // The summary starts arriving — a delta reaches the "browser" below, which
          // is the moment the call becomes committed.
          fragmentEvent('{"summary": "Looks', {
            usage: { cost: 0.05, prompt_tokens: 300, completion_tokens: 10 },
          }),
          // Then OpenRouter reports a failure inside the open 200 stream. Retryable
          // in every other circumstance — but a retry now would append a second
          // review to the half-written one.
          sseEvent({ error: { message: "provider fell over mid-stream", code: 502 } }),
        ]),
        { status: 200 },
      ),
  ]);

  const deltas: string[] = [];

  await assert.rejects(
    streamTool(
      {
        role: "synthesizer",
        messages: MESSAGES,
        tool: REVIEW_TOOL,
        streamField: "summary",
      },
      (text) => deltas.push(text),
    ),
    (error: unknown) => {
      assert.ok(error instanceof OpenRouterError);
      // Whatever the stream billed before it broke is still owed.
      assert.equal(error.usage.costUsd, 0.05);
      assert.equal(error.usage.inputTokens, 300);
      return true;
    },
  );

  assert.equal(deltas.join(""), "Looks");
  assert.equal(fetchCalls, 1, "a committed stream must not be retried");
});

test("a stream that dies before its first token is invisible to the user, so it retries like anything else", async () => {
  const deadStream = () =>
    new Response(sseBody([sseEvent({ error: { message: "boom", code: 502 } })]), {
      status: 200,
    });

  upstreamReplies([deadStream, deadStream, deadStream]);

  const deltas: string[] = [];

  await assert.rejects(
    streamTool(
      {
        role: "synthesizer",
        messages: MESSAGES,
        tool: REVIEW_TOOL,
        streamField: "summary",
      },
      (text) => deltas.push(text),
    ),
    (error: unknown) => {
      assert.ok(error instanceof OpenRouterError);
      return true;
    },
  );

  assert.equal(deltas.length, 0, "no token ever reached the caller");
  assert.equal(fetchCalls, 3, "an uncommitted stream spends the full retry budget");
});
