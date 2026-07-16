// The one Redis client in the project: Upstash over plain HTTP, no SDK.
//
// Why Redis at all: the rate limit and the spend cap are counters, and on serverless
// they cannot live in process memory — every instance would keep its own count, and the
// limit would multiply by however many instances the platform happens to be running.
// The counter has to live somewhere all instances share, and an atomic INCR over HTTP
// is the smallest possible version of "somewhere shared".
//
// Why no SDK, again: the same reason lib/openrouter.ts is plain fetch. The whole API
// surface this project needs is POST /pipeline with a JSON array of commands. An SDK
// would be a dependency standing in for eleven lines.

type CommandResult = { result?: unknown; error?: string };

export function upstashConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

// Runs the commands atomically enough for our purposes (a pipeline is sequential on
// one connection) and returns one result per command, in order. Throws on transport
// failure or on any command-level error — the callers decide what a failure means,
// because the right answer differs (see failing open, below).
export async function pipeline(commands: (string | number)[][]): Promise<unknown[]> {
  // Read inside the call, like the OpenRouter key: a missing value fails the request
  // that needed it, never the build that didn't.
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash is not configured.");

  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });

  if (!res.ok) {
    throw new Error(`Upstash responded ${res.status}.`);
  }

  const results = (await res.json()) as CommandResult[];

  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash command failed: ${failed.error}`);

  return results.map((r) => r.result);
}
