"use client";

import { useState } from "react";
import dynamic from "next/dynamic";

// CodeMirror touches `document` as it initialises, so it cannot render on the
// server. Loading it client-side only keeps the rest of the page server-rendered.
const CodeEditor = dynamic(() => import("./code-editor"), {
  ssr: false,
  loading: () => (
    <div className="h-[420px] animate-pulse rounded-md bg-surface" aria-hidden />
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

type Status = "idle" | "reviewing" | "done" | "error";

export default function ReviewPanel() {
  const [code, setCode] = useState(STARTER);
  const [status, setStatus] = useState<Status>("idle");
  const [review, setReview] = useState("");
  const [costUsd, setCostUsd] = useState(0);
  const [error, setError] = useState("");

  const busy = status === "reviewing";

  async function runReview() {
    setStatus("reviewing");
    setError("");
    setReview("");

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      const data = await res.json();

      if (!res.ok) {
        // The route always sends a human-readable `error`; falling back to a
        // status code would surface "502" to someone who cannot act on it.
        setError(data.error ?? "The review failed.");
        setStatus("error");
        return;
      }

      setReview(data.review);
      setCostUsd(data.costUsd ?? 0);
      setStatus("done");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setStatus("error");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-muted">Code</h2>
          <span className="text-xs text-muted">{code.split("\n").length} lines</span>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <CodeEditor value={code} onChange={setCode} disabled={busy} />
        </div>

        <button
          onClick={runReview}
          disabled={busy || code.trim().length === 0}
          className="self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-canvas transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Reviewing…" : "Review"}
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-muted">Review</h2>
          {status === "done" && costUsd > 0 && (
            // Shown because the whole project is an argument about the cost of
            // running agents. Hiding the number would be odd.
            <span className="text-xs text-muted">${costUsd.toFixed(5)}</span>
          )}
        </div>

        <div
          aria-live="polite"
          className="min-h-[420px] rounded-lg border border-border bg-surface p-4 text-sm leading-relaxed"
        >
          {status === "idle" && (
            <p className="text-muted">
              Paste code and press Review. Right now a single generalist model reads it —
              the planner, the specialists and the synthesizer arrive over the next few
              days.
            </p>
          )}

          {busy && <p className="animate-pulse text-muted">Reading the code…</p>}

          {status === "error" && <p className="text-high">{error}</p>}

          {status === "done" && <div className="whitespace-pre-wrap">{review}</div>}
        </div>
      </section>
    </div>
  );
}
