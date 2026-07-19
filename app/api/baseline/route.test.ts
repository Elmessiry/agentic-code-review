import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { POST } from "./route";

// Bug: completeText was called without the request's signal, so a closed tab did not
// stop the baseline's billed upstream call — it ran to completion regardless. The
// mocked fetch below does exactly what a real one does with an already-aborted
// signal (rejects rather than going out on the wire), which makes the missing
// wire-up observable: without it, the mock never sees an aborted signal and the
// request completes as if the client were still there.

const realFetch = globalThis.fetch;

function reviewRequest(signal: AbortSignal): Request {
  return new Request("http://localhost/api/baseline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "function add(a, b) {\n  return a + b;\n}\n" }),
    signal,
  });
}

const upstreamOk = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "looks fine" } }],
      usage: { cost: 0.03, prompt_tokens: 40, completion_tokens: 5 },
    }),
    { status: 200 },
  );

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  // Unconfigured Upstash means the rate limit and spend cap both fail open with no
  // fetch of their own (lib/guards/upstash.ts) — the only upstream call in this test
  // is the one completeText makes, which is the one under test.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

test("a request whose client already disconnected never comes back as a successful, billed review", async () => {
  let fetched = false;

  globalThis.fetch = (async (_url, init) => {
    fetched = true;
    if ((init as RequestInit | undefined)?.signal?.aborted) {
      // What a real fetch does when handed a signal that is already aborted: the
      // call never reaches the wire.
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return upstreamOk();
  }) as typeof fetch;

  const controller = new AbortController();
  controller.abort();

  const res = await POST(reviewRequest(controller.signal));

  assert.ok(fetched, "the upstream call still has to be attempted to be cancellable");
  assert.notEqual(
    res.status,
    200,
    "an already-disconnected client must not get back a successful, billed review",
  );
});

test("a request from a client that is still there gets its review, same as before the fix", async () => {
  globalThis.fetch = (async () => upstreamOk()) as typeof fetch;

  const controller = new AbortController();
  const res = await POST(reviewRequest(controller.signal));

  assert.equal(res.status, 200);
  const body = (await res.json()) as { review: string };
  assert.equal(body.review, "looks fine");
});
