import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { keyOf } from "../evals/cassette";
import { CANONICAL_OPENROUTER_URL } from "../lib/openrouter";

// The upstream the e2e tests talk to instead of OpenRouter: the eval fixtures, served
// over local HTTP.
//
// The eval harness replays fixtures by swapping globalThis.fetch inside its own
// process. The e2e tests cannot do that — the fetches happen inside the Next.js server,
// a separate process running the real production build — so the interception moves down
// a layer: OPENROUTER_URL points the server here, and this process answers with the
// same recordings. The demo's example snippets are the eval cases, byte for byte, which
// is why the requests a browser click produces hash to fixtures that already exist.
//
// Keys are computed against the canonical OpenRouter URL, not the localhost one the
// request actually arrived on: the recordings were made against the real API, and the
// key must match what the recorder saw — so the URL is imported from the one place
// that owns it rather than copied here.

const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 8787);

type Recorded = { status: number; body: string };

async function main(): Promise<void> {
  const calls: Record<string, Recorded> = JSON.parse(
    await readFile("evals/fixtures/calls.json", "utf8"),
  );

  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const hit = calls[keyOf(CANONICAL_OPENROUTER_URL, body)];

      if (!hit) {
        // A miss means the request no longer matches the recording — same contract as
        // replay in the eval harness: fail loudly, say how to fix it.
        console.error("[mock-upstream] no fixture for this request body");
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "No fixture for this call. Re-record with: npm run eval -- --record",
          }),
        );
        return;
      }

      res.writeHead(hit.status, { "Content-Type": "application/json" });
      res.end(hit.body);
    });
  });

  server.listen(PORT, () => {
    console.log(
      `[mock-upstream] serving ${Object.keys(calls).length} fixtures on :${PORT}`,
    );
  });
}

// A missing or corrupt fixtures file must kill this process immediately and say why.
// Left as an unhandled rejection, the trace disappears into Playwright's buffered
// server output and the visible failure is a webServer timeout, three layers away
// from the cause.
main().catch((error) => {
  console.error("[mock-upstream] failed to start", error);
  process.exit(1);
});
