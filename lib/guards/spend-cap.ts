import { pipeline, upstashConfigured } from "./upstash";

// The daily budget, counted in the only unit that cannot drift: dollars OpenRouter
// actually charged, straight from usage.cost. A cap counted in tokens or requests has
// to be re-derived every time a price or a model changes; a cap counted in money is
// the thing it protects.
//
// This is the middle layer of three. The rate limit above it slows one address down;
// the hard limit on the OpenRouter key below it is the floor a bug in this code cannot
// get past. This layer is the one that keeps an honest busy day from becoming an
// expensive one, and it fails open for the same reason the rate limit does: the key
// limit makes the worst case of a guard outage a bounded number, not an open tab.
//
// The counter is written AFTER a review and checked BEFORE the next one, so the cap
// can be overshot by however much the in-flight reviews cost. That slack is accepted:
// reserving budget up front would mean guessing a review's cost before running it,
// and refunds for the guess being wrong — bookkeeping that can itself be wrong — where
// the overshoot is bounded by the rate limit and review cost is measured in cents.

const DEFAULT_CAP_USD = 1.0;

type Ok = { ok: true };
type Err = { ok: false; response: Response };

function capUsd(): number {
  const configured = Number(process.env.DAILY_SPEND_CAP_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CAP_USD;
}

// One key per UTC day. Yesterday's key stops mattering at midnight and deletes itself
// two days later — no cron, no cleanup path to forget.
function todayKey(): string {
  return `spend:${new Date().toISOString().slice(0, 10)}`;
}

export async function checkSpendCap(): Promise<Ok | Err> {
  if (!upstashConfigured()) return { ok: true };

  try {
    const [raw] = await pipeline([["GET", todayKey()]]);
    const spent = typeof raw === "string" ? Number.parseFloat(raw) : 0;

    if (spent >= capUsd()) {
      return {
        ok: false,
        response: Response.json(
          {
            error:
              "The demo has spent its budget for today — every review costs real money, and the daily cap just protects the person paying. It resets at midnight UTC.",
          },
          // 503, not 429: the service as a whole is over budget. It is nothing this
          // caller did, and Retry-After says when the budget is back.
          {
            status: 503,
            headers: {
              "Retry-After": String(secondsToMidnightUtc()),
              "Cache-Control": "no-store",
            },
          },
        ),
      };
    }

    return { ok: true };
  } catch (error) {
    console.error("[spend-cap] check failed — allowing the request", error);
    return { ok: true };
  }
}

// Adds what a review actually cost to today's total. Never throws: the review already
// happened and the money is already spent — a bookkeeping failure after the fact is a
// log line, not a user-facing error.
export async function recordSpend(costUsd: number): Promise<void> {
  if (!upstashConfigured() || !(costUsd > 0)) return;

  try {
    await pipeline([
      ["INCRBYFLOAT", todayKey(), costUsd],
      // Two days, not one: the key must outlive its own UTC day everywhere on earth,
      // and precision past that buys nothing.
      ["EXPIRE", todayKey(), 172_800, "NX"],
    ]);
  } catch (error) {
    console.error("[spend-cap] failed to record spend", error);
  }
}

function secondsToMidnightUtc(): number {
  const now = Date.now();
  const midnight = new Date(now).setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}
