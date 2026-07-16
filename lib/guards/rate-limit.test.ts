import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { checkRateLimit } from "./rate-limit";

// The guard's contract, pinned: it must reject the eleventh request in an hour, tell
// the caller when to come back, and — just as load-bearing — get out of the way when
// the counter store is missing or down. A rate limiter that can take the demo down
// with it would be a worse failure than the one it prevents.

const realFetch = globalThis.fetch;

function upstashReplies(results: unknown[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(results.map((result) => ({ result }))), {
      status: 200,
    })) as typeof fetch;
}

function requestFrom(ip: string): Request {
  return new Request("http://localhost/api/review", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

const realVercel = process.env.VERCEL;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  // The forwarded header is only believed on the platform that rewrites it.
  process.env.VERCEL = "1";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  if (realVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = realVercel;
});

test("a request under the limit passes", async () => {
  upstashReplies([3, 1, 3000]); // INCR, EXPIRE, TTL

  const outcome = await checkRateLimit(requestFrom("203.0.113.7"));
  assert.equal(outcome.ok, true);
});

test("the request past the limit is rejected with a Retry-After", async () => {
  upstashReplies([11, 0, 1200]);

  const outcome = await checkRateLimit(requestFrom("203.0.113.7"));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;

  assert.equal(outcome.response.status, 429);
  assert.equal(outcome.response.headers.get("Retry-After"), "1200");

  const body = (await outcome.response.json()) as { error: string };
  assert.match(body.error, /20 minutes/);
});

test("counts are per address, keyed by the first forwarded hop", async () => {
  let sentKey = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const commands = JSON.parse(String(init?.body)) as string[][];
    sentKey = commands[0][1];
    return new Response(
      JSON.stringify([{ result: 1 }, { result: 1 }, { result: 3600 }]),
      { status: 200 },
    );
  }) as typeof fetch;

  await checkRateLimit(requestFrom("203.0.113.7, 10.0.0.1"));
  assert.equal(sentKey, "rate:203.0.113.7");
});

test("off the platform, the forwarded header is not believed", async () => {
  // Anywhere that does not rewrite x-forwarded-for, the header is client bytes: an
  // abuser rotating the value must not mint a fresh bucket per request. Everyone
  // shares "unknown" — stricter, never looser.
  delete process.env.VERCEL;

  let sentKey = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const commands = JSON.parse(String(init?.body)) as string[][];
    sentKey = commands[0][1];
    return new Response(
      JSON.stringify([{ result: 1 }, { result: 1 }, { result: 3600 }]),
      { status: 200 },
    );
  }) as typeof fetch;

  await checkRateLimit(requestFrom("203.0.113.7"));
  assert.equal(sentKey, "rate:unknown");
});

test("unconfigured means local dev: the guard steps aside", async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  // No fetch mock on purpose — a configured-off guard must not touch the network.
  globalThis.fetch = (async () => {
    throw new Error("the guard called out while unconfigured");
  }) as typeof fetch;

  const outcome = await checkRateLimit(requestFrom("203.0.113.7"));
  assert.equal(outcome.ok, true);
});

test("a counter-store outage fails open, not closed", async () => {
  globalThis.fetch = (async () =>
    new Response("upstream down", { status: 503 })) as typeof fetch;

  const outcome = await checkRateLimit(requestFrom("203.0.113.7"));
  assert.equal(outcome.ok, true);
});
