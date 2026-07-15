"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import PlanCard, { type PlanResult } from "./plan-card";
import FindingsPanel, { type SpecialistNode } from "./findings-panel";
import VerdictCard from "./verdict-card";
import PipelineGraph from "./pipeline-graph";
import { EXAMPLES } from "./examples";
import { sseEvents } from "@/lib/sse";
import type {
  CacheReport,
  ReviewCost,
  ReviewEvent,
  Specialist,
  SynthesizedFinding,
  Verdict,
} from "@/lib/pipeline/schema";

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
  const [error, setError] = useState("");

  // One piece of state per pipeline stage, filled in as its events land, rather than
  // one result object that appears at the end. That is the difference between a page
  // that streams and a page that spins: the planner's decision is on screen before the
  // specialists start, and the summary is being read while the findings still arrive.
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [nodes, setNodes] = useState<SpecialistNode[]>([]);
  const [summary, setSummary] = useState("");
  const [findings, setFindings] = useState<SynthesizedFinding[] | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [cost, setCost] = useState<ReviewCost | null>(null);
  const [cache, setCache] = useState<CacheReport | null>(null);

  const busy = status === "running";
  const synthesizing = busy && summary.length > 0 && findings === null;

  function upsert(specialist: Specialist, next: SpecialistNode) {
    setNodes((current) => {
      const at = current.findIndex((n) => n.specialist === specialist);
      if (at === -1) return [...current, next];

      const copy = [...current];
      copy[at] = next;
      return copy;
    });
  }

  async function run() {
    setStatus("running");
    setError("");
    setPlan(null);
    setNodes([]);
    setSummary("");
    setFindings(null);
    setVerdict(null);
    setCost(null);
    setCache(null);

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      // The guards answer before the stream opens — an oversized paste is a 413 with a
      // JSON body, not an event. Once the pipeline is running the status line has
      // already gone out, so every failure after this point arrives as an `error` event
      // instead.
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "The review failed.");
      }

      // Tracked locally, not read back from state: a setState is not visible to the
      // closure that queued it, so testing `status === "running"` after the loop would
      // read whatever it was before this run began and the check would never fire.
      let ended = false;

      for await (const raw of sseEvents(res)) {
        const event = raw as ReviewEvent;

        switch (event.type) {
          case "plan":
            setPlan(event.plan);
            break;

          case "specialist_start":
            upsert(event.specialist, {
              specialist: event.specialist,
              status: "running",
            });
            break;

          case "specialist_done":
            upsert(event.specialist, {
              specialist: event.specialist,
              status: "done",
              findings: event.findings,
              droppedLineRefs: event.droppedLineRefs,
            });
            break;

          case "specialist_error":
            upsert(event.specialist, {
              specialist: event.specialist,
              status: "failed",
              error: event.error,
            });
            break;

          case "synthesis_delta":
            setSummary((text) => text + event.text);
            break;

          case "synthesis_done":
            setFindings(event.findings);
            setVerdict(event.verdict);
            break;

          case "done":
            setCost(event.cost);
            setCache(event.cache);
            setStatus("done");
            ended = true;
            break;

          case "error":
            setError(event.error);
            setStatus("error");
            ended = true;
            break;
        }
      }

      // A stream that stops without a `done` or `error` event stopped badly — the
      // connection dropped, or the platform killed the function mid-pipeline. Left
      // alone the button would sit on "Reviewing…" forever, which is the one thing
      // worse than an error: a UI that is confidently wrong about being alive.
      if (!ended) {
        setError("The review ended early. Nothing more is coming.");
        setStatus("error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PipelineGraph
        status={status}
        plan={plan}
        nodes={nodes}
        summary={summary}
        findings={findings}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-muted text-sm font-medium">Code</h2>
            <div className="flex items-center gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example.id}
                  onClick={() => setCode(example.code)}
                  disabled={busy}
                  className="border-border text-muted hover:text-ink hover:border-accent/50 rounded-md border px-2 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {example.label}
                </button>
              ))}
            </div>
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

          {cost && cache && (
            // The cost and the cache hit rate are the argument this project is making.
            // They belong on the page, not in a log nobody opens.
            <dl className="border-border text-muted mt-1 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-dashed p-3 text-xs">
              <dt>Cost</dt>
              <dd className="text-ink text-right font-mono">
                ${cost.totalUsd.toFixed(5)}
              </dd>
              <dt className="pl-3">plan · specialists · synthesis</dt>
              <dd className="text-muted text-right font-mono">
                {cost.planUsd.toFixed(5)} · {cost.specialistsUsd.toFixed(5)} ·{" "}
                {cost.synthesisUsd.toFixed(5)}
              </dd>
              <dt>Cache ({cache.mode})</dt>
              <dd className="text-ink text-right font-mono">
                {(cache.hitRate * 100).toFixed(0)}% of{" "}
                {cache.inputTokens.toLocaleString()} tok
              </dd>
              <dt>Shared prefix</dt>
              <dd className="text-ink text-right font-mono">
                {cache.prefixTokens.toLocaleString()} tok{" "}
                {cache.clearsFloor ? "✓" : "— under floor, caching off"}
              </dd>
            </dl>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-muted text-sm font-medium">Review</h2>

          <div aria-live="polite" className="flex flex-col gap-3">
            {plan && <PlanCard plan={plan} />}

            {status === "idle" && (
              <div className="border-border bg-surface text-muted min-h-[280px] rounded-lg border p-4 text-sm">
                Paste code and press Review. A planner picks which specialists the code
                needs, they read it in parallel through one lens each, and a synthesizer
                merges what they found — resolving the places they disagree — into a
                single verdict.
              </div>
            )}

            {busy && !plan && (
              <div className="border-border bg-surface text-muted min-h-[120px] animate-pulse rounded-lg border p-4 text-sm">
                Planning…
              </div>
            )}

            {status === "error" && (
              <div className="border-border bg-surface text-high rounded-lg border p-4 text-sm">
                {error}
              </div>
            )}

            {(summary.length > 0 || findings) && (
              <VerdictCard
                summary={summary}
                findings={findings}
                verdict={verdict}
                streaming={synthesizing}
              />
            )}

            <FindingsPanel nodes={nodes} />
          </div>
        </section>
      </div>
    </div>
  );
}
