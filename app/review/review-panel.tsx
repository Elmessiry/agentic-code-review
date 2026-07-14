"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import PlanCard from "./plan-card";
import FindingsPanel from "./findings-panel";
import type { ReviewResponse } from "@/lib/pipeline/schema";

// CodeMirror touches `document` as it initialises, so it cannot render on the
// server. Loading it client-side only keeps the rest of the page server-rendered.
const CodeEditor = dynamic(() => import("./code-editor"), {
  ssr: false,
  loading: () => (
    <div className="bg-surface h-[420px] animate-pulse rounded-md" aria-hidden />
  ),
});

const STARTER = `app.post("/search", async (req, res) => {
  const term = sanitizeHtml(req.body.term);
  const schema = JSON.parse(fs.readFileSync("./schema.json"));
  const rows = await db.all("SELECT * FROM items WHERE owner = " + req.body.owner);
  const out = [];
  for (const row of rows) {
    if (validate(row, schema)) {
      out.push(await enrich(row));
    }
  }
  res.send("<ul>" + out.map((r) => "<li>" + r.name + "</li>").join("") + "</ul>");
});
`;

type Status = "idle" | "running" | "done" | "error";

export default function ReviewPanel() {
  const [code, setCode] = useState(STARTER);
  const [status, setStatus] = useState<Status>("idle");
  // The shape is declared once, in lib/pipeline/schema.ts, and the route is annotated
  // with the same type — so a field the server stops sending fails the build here
  // rather than throwing in a browser.
  const [result, setResult] = useState<ReviewResponse | null>(null);
  const [error, setError] = useState("");

  const busy = status === "running";

  async function run() {
    setStatus("running");
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/specialists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "The review failed.");

      setResult(data);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStatus("error");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-muted text-sm font-medium">Code</h2>
          <span className="text-muted text-xs">{code.split("\n").length} lines</span>
        </div>

        <div className="border-border bg-surface overflow-hidden rounded-lg border">
          <CodeEditor value={code} onChange={setCode} disabled={busy} />
        </div>

        <button
          onClick={run}
          disabled={busy || code.trim().length === 0}
          className="bg-accent text-canvas self-start rounded-md px-4 py-2 text-sm font-medium transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Reviewing…" : "Review"}
        </button>

        {result && (
          // The cost and the cache hit rate are the argument this project is making.
          // They belong on the page, not in a log nobody opens.
          <dl className="border-border text-muted mt-1 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-dashed p-3 text-xs">
            <dt>Cost</dt>
            <dd className="text-ink text-right font-mono">
              ${result.cost.totalUsd.toFixed(5)}
            </dd>
            <dt>Cache ({result.cache.mode})</dt>
            <dd className="text-ink text-right font-mono">
              {(result.cache.hitRate * 100).toFixed(0)}% of{" "}
              {result.cache.inputTokens.toLocaleString()} tok
            </dd>
            <dt>Shared prefix</dt>
            <dd className="text-ink text-right font-mono">
              {result.cache.prefixTokens.toLocaleString()} tok{" "}
              {result.cache.clearsFloor ? "✓" : "— under floor, caching off"}
            </dd>
          </dl>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-muted text-sm font-medium">Review</h2>

        <div aria-live="polite" className="flex flex-col gap-3">
          {result && <PlanCard plan={result.plan} />}

          {status === "idle" && (
            <div className="border-border bg-surface text-muted min-h-[280px] rounded-lg border p-4 text-sm">
              Paste code and press Review. A planner picks which specialists the code
              needs, they read it in parallel, and each reports through its own lens.
              Resolving the places they disagree is the next piece to land.
            </div>
          )}

          {busy && (
            <div className="border-border bg-surface text-muted min-h-[280px] animate-pulse rounded-lg border p-4 text-sm">
              Planning, then reading…
            </div>
          )}

          {status === "error" && (
            <div className="border-border bg-surface text-high min-h-[120px] rounded-lg border p-4 text-sm">
              {error}
            </div>
          )}

          {result && (
            <FindingsPanel reports={result.results} failures={result.failures} />
          )}
        </div>
      </section>
    </div>
  );
}
