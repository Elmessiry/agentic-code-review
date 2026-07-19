import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { billedSoFar, runReview } from "./review";
import type { ReviewEvent } from "./schema";

// Two ways a review can die with money already spent and no "plan" or "done" event
// to say so. Both are pinned here against a mocked wire, in the same idiom as
// lib/openrouter.test.ts: the retry loop and the caching fan-out are the real thing,
// only the HTTP call underneath is faked.
//
//   1. The planner exhausts completeWithRetry's budget before ever answering. The
//      "plan" event only fires on success, so the planner's billed retries had no
//      event to ride on and the route recorded $0 for a call that was not free.
//
//   2. The client disconnects while the synthesizer is mid-stream. runSynthesis
//      rethrows rather than fabricating a fallback for a review nobody will read —
//      correctly — but that rethrow used to leave the specialists' cost stranded:
//      it only ever reaches the ledger folded into fan.costUsd on "done", and "done"
//      never fires for an abandoned run.
//
// In both cases the fix is the same shape: an "error" event that carries `costUsd`
// set to whatever was actually billed, so billedSoFar (the function the route reads
// its running total from) sees the true number instead of silently keeping whatever
// it already had.

const realFetch = globalThis.fetch;

const CODE = "function add(a, b) {\n  return a + b;\n}\n";

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

const http = (status: number) => () => new Response("upstream said no", { status });

// Which forced tool a call is for, read off the request body rather than off call
// order — the fan-out launches specialists concurrently, so "the Nth fetch" is not a
// stable way to say "the security specialist's call".
function toolNameOf(init: RequestInit | undefined): string | undefined {
  const body = JSON.parse((init?.body as string) ?? "{}") as {
    tools?: { function?: { name?: string } }[];
  };
  return body.tools?.[0]?.function?.name;
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

test("a planner that exhausts its retries emits no plan event, but bills what it spent", async () => {
  let calls = 0;
  const replies = [
    http(500),
    // A malformed 200 — the planner answered with prose instead of calling the
    // forced tool. Still cost real money.
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "no tool call" } }],
          usage: { cost: 0.01, prompt_tokens: 100, completion_tokens: 10 },
        }),
        { status: 200 },
      ),
    http(500),
  ];
  globalThis.fetch = (async () => {
    const reply = replies[calls];
    calls += 1;
    if (!reply) throw new Error(`unexpected upstream call #${calls}`);
    return reply();
  }) as typeof fetch;

  const events: ReviewEvent[] = [];
  await runReview(CODE, (e) => events.push(e));

  assert.ok(
    !events.some((e) => e.type === "plan"),
    "a planner that never answered has no decision to report",
  );
  assert.ok(
    !events.some((e) => e.type === "done"),
    "there is nothing to fan out over without a plan",
  );

  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(errorEvent, "a dead planner still needs a terminal event");
  if (!errorEvent || errorEvent.type !== "error") return;

  assert.equal(
    errorEvent.costUsd,
    0.01,
    "the planner's billed retries must ride on the error event",
  );

  let billed = 0;
  for (const e of events) billed = billedSoFar(e, billed);
  assert.equal(
    billed,
    0.01,
    "the route's running total (billedSoFar) must see the planner's cost, not $0",
  );
});

test("a synthesis abandoned by a client disconnect still bills the plan and the specialists that already ran", async () => {
  const controller = new AbortController();

  globalThis.fetch = (async (_url, init) => {
    const name = toolNameOf(init as RequestInit | undefined);

    if (name === "select_specialists") {
      return toolCallReply(
        { relevant_agents: ["security"], reasoning: "touches user input directly" },
        { cost: 0.001, prompt_tokens: 50, completion_tokens: 10 },
      )();
    }

    if (name === "report_findings") {
      return toolCallReply(
        { findings: [{ severity: "high", line: 1, issue: "x", suggestion: "y" }] },
        { cost: 0.002, prompt_tokens: 80, completion_tokens: 20 },
      )();
    }

    if (name === "write_review") {
      // The tab closes while the synthesizer is mid-flight. The route's
      // AbortController fires; completeWithRetry's own `opts.signal?.aborted`
      // check (lib/openrouter.ts) stops the loop rather than retrying an answer
      // with no recipient.
      controller.abort(new Error("client disconnected"));
      return new Response("won't be read", { status: 500 });
    }

    throw new Error(`unexpected tool call: ${name}`);
  }) as typeof fetch;

  const events: ReviewEvent[] = [];
  await runReview(CODE, (e) => events.push(e), controller.signal);

  assert.ok(
    !events.some((e) => e.type === "done"),
    "an abandoned synthesis never reaches done",
  );

  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(errorEvent, "an abandoned run still needs a terminal event");
  if (!errorEvent || errorEvent.type !== "error") return;

  // 0.001 (the plan) + 0.002 (the one specialist that ran) + 0 (the synthesizer never
  // got billed before it aborted). Before the fix this was 0: specialist_done only
  // ever carries findings, never cost, so nothing but "done" surfaced fan.costUsd —
  // and "done" is exactly the event an abandoned run never reaches.
  assert.equal(errorEvent.costUsd, 0.003);

  let billed = 0;
  for (const e of events) billed = billedSoFar(e, billed);
  assert.equal(
    billed,
    0.003,
    "the specialists' already-billed spend must not vanish when synthesis is abandoned",
  );
});
