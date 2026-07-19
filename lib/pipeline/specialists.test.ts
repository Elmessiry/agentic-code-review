import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fanOut } from "./specialists";

// The fan-out contract from AGENTS.md: "no rejection may cross the fan-out boundary."
// A dead specialist's failure is data, attributed by name, and its billed attempts
// still count toward the total the user is shown. The other cost decision pinned here
// is the warm-then-fan sequencing an explicit-caching model needs — one specialist
// writes the cache before the rest fan out as readers, and a warmer that dies hands the
// job to the next specialist in line rather than letting the group launch cold.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL_SPECIALIST;
});

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
});

const CODE = "const x = 1;\nconst y = 2;\n"; // two lines — enough for line refs to validate

// Every SPECIALIST_INSTRUCTIONS entry opens with "Your lens is <NAME>", and that is
// the only place a mocked fetch can tell which specialist a request belongs to — the
// system prefix is byte-identical across all four on purpose.
function specialistOf(body: { messages: { role: string; content: unknown }[] }): string {
  const userContent = body.messages.find((m) => m.role === "user")?.content;
  if (typeof userContent !== "string") throw new Error("no user message in request");
  if (userContent.startsWith("Your lens is SECURITY")) return "security";
  if (userContent.startsWith("Your lens is PERFORMANCE")) return "performance";
  if (userContent.startsWith("Your lens is READABILITY")) return "readability";
  if (userContent.startsWith("Your lens is TEST COVERAGE")) return "tests";
  throw new Error(`could not identify specialist from: ${userContent.slice(0, 40)}`);
}

const http = (status: number) => () => new Response("upstream said no", { status });

function toolCallReply(
  findings: unknown[],
  usage: Record<string, unknown>,
): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [{ function: { arguments: JSON.stringify({ findings }) } }],
            },
          },
        ],
        usage,
      }),
      { status: 200 },
    );
}

// A 200 the model answered in prose instead of calling the forced tool — unusable, but
// billed, exactly like the malformed-200 case pinned in lib/openrouter.test.ts.
function malformedButBilled(usage: Record<string, unknown>): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "prose instead of a tool call" } }],
        usage,
      }),
      { status: 200 },
    );
}

// Routes each fetch to the queued reply for that specialist, in order, and records
// the call log the sequencing tests read. A call past the end of a specialist's queue
// fails loudly — the queue length IS the attempt budget under test.
function mockFetchPerSpecialist(
  replies: Partial<Record<string, (() => Response)[]>>,
  log: string[] = [],
): string[] {
  const counters: Record<string, number> = {};

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: unknown }[];
    };
    const specialist = specialistOf(body);
    const n = counters[specialist] ?? 0;
    counters[specialist] = n + 1;

    log.push(`${specialist}:request${n}`);

    const queue = replies[specialist];
    if (!queue || !queue[n]) {
      throw new Error(`unexpected fetch for ${specialist}, attempt ${n}: budget leaked`);
    }
    return queue[n]();
  }) as typeof fetch;

  return log;
}

test("a specialist whose upstream dies on every attempt does not reject the fan-out: the other specialist's findings and cost survive, and the failure is attributed by name", async () => {
  mockFetchPerSpecialist({
    // Two upstream 500s, then a malformed 200 the model still gets billed for before
    // the retry budget runs out — the same three-strikes shape openrouter.test.ts
    // pins, just reached here through the fan-out.
    security: [
      http(500),
      http(500),
      malformedButBilled({ cost: 0.03, prompt_tokens: 90, completion_tokens: 10 }),
    ],
    performance: [
      toolCallReply(
        [
          {
            severity: "medium",
            line: 1,
            issue: "x is never reassigned",
            suggestion: "use const... it already is",
          },
        ],
        {
          cost: 0.05,
          prompt_tokens: 200,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      ),
    ],
  });

  const outcome = await fanOut(["security", "performance"], CODE);

  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].specialist, "security");
  assert.equal(outcome.failures[0].error, "This specialist could not be reached.");

  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].specialist, "performance");
  assert.equal(outcome.results[0].findings.length, 1);
  assert.equal(outcome.results[0].findings[0].issue, "x is never reassigned");

  // The dead specialist's billed malformed attempt (0.03) is not lost — it is folded
  // into the total alongside the survivor's cost (0.05).
  assert.ok(
    Math.abs(outcome.costUsd - 0.08) < 1e-9,
    `expected costUsd close to 0.08, got ${outcome.costUsd}`,
  );
});

test("fanOut resolves even when every specialist fails — an empty result set and failures for all of them, never a rejection", async () => {
  mockFetchPerSpecialist({
    security: [http(500), http(500), http(500)],
    performance: [http(500), http(500), http(500)],
  });

  const outcome = await fanOut(["security", "performance"], CODE);

  assert.equal(outcome.results.length, 0);
  assert.deepEqual(outcome.failures.map((f) => f.specialist).sort(), [
    "performance",
    "security",
  ]);
});

test("an explicit-caching model warms the cache with the first specialist before the rest start: the second specialist's fetch is not called until the first's has resolved", async () => {
  process.env.OPENROUTER_MODEL_SPECIALIST = "anthropic/claude-haiku-4.5"; // explicit caching

  const order: string[] = [];

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: unknown }[];
    };
    const specialist = specialistOf(body);
    order.push(`${specialist}:start`);

    // The warmer resolves on a macrotask delay, so a caller that fired the fan-out
    // group concurrently (the bug this test exists to catch) would call the second
    // specialist's fetch before this resolves, not after.
    if (specialist === "security") await new Promise((r) => setTimeout(r, 20));

    order.push(`${specialist}:end`);
    return toolCallReply([], { cost: 0.01, prompt_tokens: 10, completion_tokens: 1 })();
  }) as typeof fetch;

  const outcome = await fanOut(["security", "performance"], CODE);

  assert.deepEqual(order, [
    "security:start",
    "security:end",
    "performance:start",
    "performance:end",
  ]);
  assert.equal(outcome.failures.length, 0);
  assert.equal(outcome.results.length, 2);
});

test("a failed warmer promotes the next specialist to warmer, rather than launching the remaining group cold", async () => {
  process.env.OPENROUTER_MODEL_SPECIALIST = "anthropic/claude-haiku-4.5"; // explicit caching

  const log: string[] = [];
  mockFetchPerSpecialist(
    {
      // Non-retryable: dies on its single attempt, fast, no retry backoff.
      security: [http(400)],
      performance: [
        toolCallReply([], { cost: 0.02, prompt_tokens: 50, completion_tokens: 5 }),
      ],
      readability: [
        toolCallReply([], { cost: 0.01, prompt_tokens: 20, completion_tokens: 2 }),
      ],
    },
    log,
  );

  const outcome = await fanOut(["security", "performance", "readability"], CODE);

  // security (the original warmer) is attempted, and fails, entirely before
  // performance (promoted to warmer) is attempted at all.
  const securityIndex = log.indexOf("security:request0");
  const performanceIndex = log.indexOf("performance:request0");
  const readabilityIndex = log.indexOf("readability:request0");

  assert.ok(
    securityIndex < performanceIndex,
    "the failed warmer runs before its successor",
  );
  assert.ok(
    performanceIndex < readabilityIndex,
    "the promoted warmer runs before the parallel group it clears the way for",
  );

  assert.deepEqual(
    outcome.failures.map((f) => f.specialist),
    ["security"],
  );
  assert.deepEqual(outcome.results.map((r) => r.specialist).sort(), [
    "performance",
    "readability",
  ]);
});
