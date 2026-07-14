"use client";

import {
  SPECIALIST_LABELS,
  type Severity,
  type SynthesizedFinding,
  type Verdict,
} from "@/lib/pipeline/schema";

// The synthesized review: one verdict, one summary, one merged list of findings.
//
// This is the output the user actually reads, and everything below it — the four
// specialists' raw reports — is the audit trail that backs it up. That ordering is the
// argument: four lists stapled together is not a review, it is homework. A review says
// what is wrong, what it costs, and whether to merge.

const VERDICTS: Record<Verdict, { label: string; className: string }> = {
  approve: { label: "Approve", className: "border-low/50 bg-low/10 text-low" },
  changes_requested: {
    label: "Changes requested",
    className: "border-medium/50 bg-medium/10 text-medium",
  },
  reject: { label: "Reject", className: "border-high/50 bg-high/10 text-high" },
};

const SEVERITY: Record<Severity, { dot: string; label: string }> = {
  high: { dot: "bg-high", label: "text-high" },
  medium: { dot: "bg-medium", label: "text-medium" },
  low: { dot: "bg-low", label: "text-low" },
};

export default function VerdictCard({
  summary,
  findings,
  verdict,
  streaming,
}: {
  summary: string;
  findings: SynthesizedFinding[] | null;
  verdict: Verdict | null;
  streaming: boolean;
}) {
  return (
    <div className="border-border bg-surface rounded-lg border p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold tracking-wide uppercase">Review</h3>

        {verdict && (
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${VERDICTS[verdict].className}`}
          >
            {VERDICTS[verdict].label}
          </span>
        )}
      </div>

      <p className="text-sm leading-relaxed whitespace-pre-wrap">
        {summary}
        {/* The summary streams a word at a time, so it spends most of its life
            half-written. A caret says "still arriving" — without it, a sentence that
            stops mid-clause reads as a bug. */}
        {streaming && (
          <span className="bg-accent ml-0.5 inline-block h-4 w-1.5 animate-pulse align-middle" />
        )}
      </p>

      {findings && findings.length > 0 && (
        <ul className="mt-4">
          {findings.map((f, i) => (
            <li key={`${f.line}-${i}`} className="border-border/60 border-t py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${SEVERITY[f.severity].dot}`}
                  aria-hidden
                />
                <span className={`text-xs font-medium ${SEVERITY[f.severity].label}`}>
                  {f.severity}
                </span>
                <span className="text-muted font-mono text-xs">line {f.line}</span>

                {/* Who raised it. More than one name is the interesting case: the same
                    defect seen independently through two lenses, which is the closest
                    thing to corroboration this pipeline can produce. */}
                {f.sources.length > 0 && (
                  <span className="text-muted text-xs">
                    {f.sources.length > 1 ? "agreed by" : "raised by"}{" "}
                    {f.sources.map((s) => SPECIALIST_LABELS[s]).join(", ")}
                  </span>
                )}
              </div>

              <p className="mt-1.5 text-sm">{f.issue}</p>
              <p className="text-muted mt-1 font-mono text-xs leading-relaxed">
                {f.suggestion}
              </p>

              {/* Only present where the specialists actually disagreed. This is the
                  line that could not have come from any single reviewer. */}
              {f.note && (
                <p className="border-border text-muted mt-2 border-l-2 pl-2 text-xs italic">
                  {f.note}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {findings && findings.length === 0 && (
        <p className="text-muted mt-3 text-sm">
          Nothing survived synthesis. The specialists raised nothing worth the
          author&apos;s attention.
        </p>
      )}
    </div>
  );
}
