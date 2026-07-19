import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { checkSpendCap, recordSpend } from "./spend-cap";

// The cap that keeps a busy day from becoming an expensive one. The contract: reject
// once today's recorded spend reaches the cap, count in the dollars OpenRouter actually
// charged, and never let its own bookkeeping take a review down.

const realFetch = globalThis.fetch;

function upstashReplies(results: unknown[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(results.map((result) => ({ result }))), {
      status: 200,
    })) as typeof fetch;
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.DAILY_SPEND_CAP_USD;
});

test("spend under the cap passes", async () => {
  upstashReplies(["0.42"]);

  const outcome = await checkSpendCap();
  assert.equal(outcome.ok, true);
});

test("spend at the cap is refused as a service condition, with a reset time", async () => {
  process.env.DAILY_SPEND_CAP_USD = "1.00";
  upstashReplies(["1.00"]);

  const outcome = await checkSpendCap();
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;

  // 503, not 429 — the service is over budget; it is nothing this caller did.
  assert.equal(outcome.response.status, 503);

  const retryAfter = Number(outcome.response.headers.get("Retry-After"));
  assert.ok(retryAfter > 0 && retryAfter <= 86_400, `Retry-After was ${retryAfter}`);
});

test("no spend recorded yet reads as zero, not as a rejection", async () => {
  upstashReplies([null]); // GET on a missing key

  const outcome = await checkSpendCap();
  assert.equal(outcome.ok, true);
});

test("recordSpend adds real dollars to today's key and sets its expiry once", async () => {
  let commands: string[][] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    commands = JSON.parse(String(init?.body)) as string[][];
    return new Response(JSON.stringify([{ result: "0.03" }, { result: 1 }]), {
      status: 200,
    });
  }) as typeof fetch;

  await recordSpend(0.030722);

  assert.equal(commands[0][0], "INCRBYFLOAT");
  assert.match(commands[0][1], /^spend:\d{4}-\d{2}-\d{2}$/);
  assert.equal(commands[0][2], "0.030722");
  assert.deepEqual(commands[1], ["EXPIRE", commands[0][1], "172800", "NX"]);
});

test("zero, negative, or absent cost is not a Redis call", async () => {
  globalThis.fetch = (async () => {
    throw new Error("recordSpend called out for zero spend");
  }) as typeof fetch;

  await recordSpend(0);
  await recordSpend(NaN);
  // The guard is `costUsd > 0`, not `costUsd !== 0` — a negative number (a refund, a
  // bookkeeping bug upstream) must not decrement today's counter either.
  await recordSpend(-5);
});

test("a bookkeeping failure is swallowed — the review already happened", async () => {
  globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;

  await assert.doesNotReject(recordSpend(0.05));
});

test("a store outage on the check fails open", async () => {
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;

  const outcome = await checkSpendCap();
  assert.equal(outcome.ok, true);
});
