"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import PlanCard, { type PlanResult } from "./plan-card";

// CodeMirror touches `document` as it initialises, so it cannot render on the
// server. Loading it client-side only keeps the rest of the page server-rendered.
const CodeEditor = dynamic(() => import("./code-editor"), {
  ssr: false,
  loading: () => (
    <div className="bg-surface h-[420px] animate-pulse rounded-md" aria-hidden />
  ),
});

const STARTER = `function getUser(req, res) {
  const id = req.query.id;
  const query = "SELECT * FROM users WHERE id = " + id;

  db.execute(query, (err, rows) => {
    if (err) {
      res.status(500).send(err.message);
      return;
    }
    res.json(rows[0]);
  });
}
`;

type Status = "idle" | "planning" | "reviewing" | "done" | "error";

export default function ReviewPanel() {
  const [code, setCode] = useState(STARTER);
  const [status, setStatus] = useState<Status>("idle");
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [review, setReview] = useState("");
  const [costUsd, setCostUsd] = useState(0);
  const [error, setError] = useState("");

  const busy = status === "planning" || status === "reviewing";

  async function post(path: string, body: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "The request failed.");
    return data;
  }

  async function run() {
    setStatus("planning");
    setError("");
    setReview("");
    setPlan(null);

    try {
      // The plan lands first and renders immediately. Waiting until the review is
      // also done would throw away the point of having a planner you can audit —
      // the decision is worth seeing while the work it caused is still running.
      const decision: PlanResult = await post("/api/plan", { code });
      setPlan(decision);

      setStatus("reviewing");
      const result = await post("/api/review", { code });

      setReview(result.review);
      setCostUsd(decision.costUsd + (result.costUsd ?? 0));
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
          {status === "planning"
            ? "Planning…"
            : status === "reviewing"
              ? "Reviewing…"
              : "Review"}
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-muted text-sm font-medium">Review</h2>
          {status === "done" && costUsd > 0 && (
            // The whole project is an argument about what it costs to run agents.
            // Hiding the number would be a strange way to make it.
            <span className="text-muted text-xs">${costUsd.toFixed(5)}</span>
          )}
        </div>

        <div aria-live="polite" className="flex flex-col gap-3">
          {plan && <PlanCard plan={plan} />}

          <div className="border-border bg-surface min-h-[280px] rounded-lg border p-4 text-sm leading-relaxed">
            {status === "idle" && (
              <p className="text-muted">
                Paste code and press Review. The planner decides which specialists the
                code needs — then, for now, a single generalist writes the review. The
                specialists themselves land next.
              </p>
            )}

            {status === "planning" && (
              <p className="text-muted animate-pulse">Deciding who should look…</p>
            )}

            {status === "reviewing" && (
              <p className="text-muted animate-pulse">Reading the code…</p>
            )}

            {status === "error" && <p className="text-high">{error}</p>}

            {status === "done" && <div className="whitespace-pre-wrap">{review}</div>}
          </div>
        </div>
      </section>
    </div>
  );
}
