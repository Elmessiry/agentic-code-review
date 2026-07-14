"use client";

import {
  SPECIALIST_LABELS,
  type Finding,
  type ReviewResponse,
} from "@/lib/pipeline/schema";

// One source of truth for the payload shape: lib/pipeline/schema.ts.
export type SpecialistReport = ReviewResponse["results"][number];
export type Failure = ReviewResponse["failures"][number];

const SEVERITY: Record<Finding["severity"], { dot: string; label: string }> = {
  high: { dot: "bg-high", label: "text-high" },
  medium: { dot: "bg-medium", label: "text-medium" },
  low: { dot: "bg-low", label: "text-low" },
};

const ORDER: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };

function FindingRow({ finding }: { finding: Finding }) {
  const tone = SEVERITY[finding.severity];

  return (
    <li className="border-border/60 border-t py-3 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
        <span className={`text-xs font-medium ${tone.label}`}>{finding.severity}</span>
        <span className="text-muted font-mono text-xs">line {finding.line}</span>
      </div>
      <p className="mt-1.5 text-sm">{finding.issue}</p>
      <p className="text-muted mt-1 font-mono text-xs leading-relaxed">
        {finding.suggestion}
      </p>
    </li>
  );
}

export default function FindingsPanel({
  reports,
  failures,
}: {
  reports: SpecialistReport[];
  failures: Failure[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {reports.map((report) => {
        const findings = [...report.findings].sort(
          (a, b) => ORDER[a.severity] - ORDER[b.severity],
        );

        return (
          <section
            key={report.specialist}
            className="border-border bg-surface rounded-lg border p-4"
          >
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold tracking-wide uppercase">
                {SPECIALIST_LABELS[report.specialist]}
              </h3>
              <span className="text-muted text-xs">
                {findings.length === 0
                  ? "nothing to report"
                  : `${findings.length} finding${findings.length === 1 ? "" : "s"}`}
              </span>
            </div>

            {findings.length === 0 ? (
              // An empty list is a real answer, not an absence of one. Saying so out
              // loud stops it reading as though the specialist silently failed.
              <p className="text-muted mt-2 text-sm">
                This specialist read the code and found nothing through its lens.
              </p>
            ) : (
              <ul className="mt-1">
                {findings.map((f, i) => (
                  <FindingRow key={`${f.line}-${i}`} finding={f} />
                ))}
              </ul>
            )}

            {report.droppedLineRefs > 0 && (
              // Surfaced, not swallowed. A specialist inventing line numbers is a
              // specialist to stop paying for, and that is only visible if it is said.
              <p className="text-muted mt-3 text-xs">
                {report.droppedLineRefs} finding
                {report.droppedLineRefs === 1 ? "" : "s"} discarded for pointing at a line
                that does not exist.
              </p>
            )}
          </section>
        );
      })}

      {failures.map((f) => (
        // A specialist that failed is a specialist that failed. The other three still
        // ran, and their findings are still worth reading — so the failure is reported
        // in place rather than replacing the review with an error page.
        <section
          key={f.specialist}
          className="border-border bg-surface rounded-lg border border-dashed p-4"
        >
          <div className="flex items-baseline justify-between">
            <h3 className="text-muted text-xs font-semibold tracking-wide uppercase">
              {SPECIALIST_LABELS[f.specialist]}
            </h3>
            <span className="text-medium text-xs">failed</span>
          </div>
          <p className="text-muted mt-2 text-sm">
            {f.error} The other specialists finished, so the rest of this review still
            stands.
          </p>
        </section>
      ))}
    </div>
  );
}
