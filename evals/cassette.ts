import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Recording every upstream call once, so CI can replay them for free.
//
// The alternative — running the evals against the live API on every push — has two
// failure modes and both of them are fatal to the habit. It costs real money per commit,
// and it is nondeterministic: a model that phrases a finding differently today turns the
// build red for no reason, and a build that goes red for no reason is a build people learn
// to ignore. An eval suite nobody trusts is worse than no eval suite, because it still
// costs money.
//
// So the calls are recorded once, deliberately, with `--record`, and CI replays them.
// Replay proves the PIPELINE is correct — the routing, the tripwire, the merge, the line
// validation, the verdict, the totals — which is the part that changes when somebody edits
// this repo. Whether the MODELS still behave is a different question with a different
// answer, and it belongs on a nightly job against the real API, not in a pull request.
//
// The key is a hash of the request itself, so a fixture is only ever served to the call
// that produced it. Change a prompt and the key changes: the fixture misses, loudly, and
// tells you to re-record. A cassette that silently serves a stale answer to a changed
// prompt would be the single worst bug this file could have.

const FIXTURES = "evals/fixtures/calls.json";

type Recorded = { status: number; body: string };

function keyOf(url: string, body: string): string {
  return createHash("sha256").update(`${url}\n${body}`).digest("hex").slice(0, 16);
}

function requestOf(input: unknown, init?: RequestInit): { url: string; body: string } {
  const url = typeof input === "string" ? input : String(input);
  return { url, body: typeof init?.body === "string" ? init.body : "" };
}

// Intercepts fetch, lets every call through to the real API, and keeps a copy of each
// response. Returns the function that writes them all to disk.
export function record(): () => Promise<number> {
  const real = globalThis.fetch;
  const calls: Record<string, Recorded> = {};
  const pending: Promise<void>[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { url, body } = requestOf(input, init);
    const res = await real(input as RequestInfo, init);

    // clone() tees the body, so the copy can be drained to disk while the caller reads
    // the original as a stream. Reading the original here instead would consume it, and
    // the synthesizer would receive an already-empty stream.
    const copy = res.clone();
    pending.push(
      copy.text().then((text) => {
        calls[keyOf(url, body)] = { status: res.status, body: text };
      }),
    );

    return res;
  }) as typeof fetch;

  return async () => {
    await Promise.all(pending);
    await writeFile(FIXTURES, `${JSON.stringify(calls, null, 2)}\n`);
    return Object.keys(calls).length;
  };
}

// Serves the recorded responses and never touches the network.
export async function replay(): Promise<number> {
  const calls: Record<string, Recorded> = JSON.parse(await readFile(FIXTURES, "utf8"));

  // The key is read inside the request handler and a missing one is a loud throw — which
  // is right in production and pointless here, where no request leaves the process. CI has
  // no secret, and it should not need one to prove the pipeline still works.
  process.env.OPENROUTER_API_KEY ??= "replaying-from-fixtures";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { url, body } = requestOf(input, init);
    const hit = calls[keyOf(url, body)];

    if (!hit) {
      // A miss means the request changed — a prompt was edited, a model was swapped, a
      // case was added. That is not an error to paper over with a live call: it means the
      // fixtures no longer describe this pipeline, and pretending otherwise would let a
      // stale recording vouch for code it never ran against.
      throw new Error(
        `No fixture for this call. The request changed (a prompt, a model, or a case), ` +
          `so the recording no longer matches the pipeline. Re-record with:\n\n` +
          `    npm run eval -- --record\n`,
      );
    }

    return new Response(hit.body, {
      status: hit.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return Object.keys(calls).length;
}
