import { pipeline, upstashConfigured } from "./upstash";

// Ten reviews per hour per IP — a demo allowance, not an SLA.
//
// A fixed window (INCR a per-IP key, expire it in an hour) over a sliding one, on
// purpose. The sliding window's selling point is that nobody can burst 2x the limit
// across a window boundary; its price is a sorted set per IP and more commands per
// check. For a demo whose worst case is "someone got twenty reviews this hour instead
// of ten", the burst is not worth defending against — the spend cap is the guard that
// holds the actual budget, and the provider-level key limit holds the bill.
//
// FAILING OPEN is the deliberate choice here. If Upstash is down or unconfigured, the
// review proceeds and the failure goes to the log. Failing closed would make the demo's
// availability depend on infrastructure the review itself never touches, and the cost
// of a guard outage is bounded by the two layers underneath: the daily spend cap
// (checked separately) and the hard limit on the key itself, which no outage in our
// code can lift. Unconfigured is the normal state of local dev, not an error.

const LIMIT = 10;
const WINDOW_SECONDS = 3600;

type Ok = { ok: true };
type Err = { ok: false; response: Response };

// The first hop in x-forwarded-for is the client — but only somewhere that overwrites
// the header, and that is a property of the platform, not of the request. On Vercel
// the platform writes it and a caller cannot spoof it; anywhere else it is just bytes
// the client sent, and trusting it hands out a fresh rate-limit bucket per request to
// anyone who rotates the value. So the trust is gated on the platform's own marker,
// in code rather than in a comment. Untrusted requests share one "unknown" bucket:
// on a laptop that is everyone (where the limit only matters when testing the limit),
// and on an unrecognised host it fails toward stricter, never looser.
function clientIp(request: Request): string {
  if (!process.env.VERCEL) return "unknown";

  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

export async function checkRateLimit(request: Request): Promise<Ok | Err> {
  if (!upstashConfigured()) return { ok: true };

  const key = `rate:${clientIp(request)}`;

  try {
    // INCR first, EXPIRE NX second: the expiry is set only by the request that created
    // the key, so the window starts at the first request and survives the rest. TTL
    // rides along so the rejection can say when to come back.
    const [count, , ttl] = await pipeline([
      ["INCR", key],
      ["EXPIRE", key, WINDOW_SECONDS, "NX"],
      ["TTL", key],
    ]);

    if (typeof count === "number" && count > LIMIT) {
      const retryAfter = typeof ttl === "number" && ttl > 0 ? ttl : WINDOW_SECONDS;
      const minutes = Math.max(1, Math.ceil(retryAfter / 60));

      return {
        ok: false,
        response: Response.json(
          {
            error: `That's ${LIMIT} reviews in an hour — the demo's limit from one address. It resets in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(retryAfter),
              "Cache-Control": "no-store",
            },
          },
        ),
      };
    }

    return { ok: true };
  } catch (error) {
    console.error("[rate-limit] check failed — allowing the request", error);
    return { ok: true };
  }
}
