"use client";

import { SPECIALIST_LABELS, type Finding, type Specialist } from "@/lib/pipeline/schema";

// What each specialist reported, on its own, before the synthesizer merged it.
//
// This is the audit trail, not the review — the review is the verdict card above it.
// It stays visible because a merged finding that credits "Security, Performance" is
// only believable if you can go and read what Security and Performance actually said.
// A synthesizer is a language model too, and the check on it is that its inputs are on
// the page.
//
// It also renders the pipeline as it happens: a specialist is running, done, or dead,
// and each of those is a state the user can see rather than infer from a spinner.

export type SpecialistNode =
  | { specialist: Specialist; status: "running" }
  | {
      specialist: Specialist;
      status: "done";
      findings: Finding[];
      droppedLineRefs: number;
    }
  | { specialist: Specialist; status: "failed"; error: string };

const SEVERITY: Record<Finding["severity"], { dot: string; label: string }> = {
  high: { dot: "bg-high", label: "text-high" },
  medium: { dot: "bg-medium", label: "text-medium" },
  low: { dot: "bg-low", label: "text-low" },
};

const ORDER: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };

function FindingRow({ finding }: { finding: Finding }) {
  const tone = SEVERITY[finding.severity];

  return (
    <li className="border-border/60 border-t py-2.5 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
        <span className={`text-xs font-medium ${tone.label}`}>{finding.severity}</span>
        <span className="text-muted font-mono text-xs">line {finding.line}</span>
      </div>
      <p className="mt-1 text-sm">{finding.issue}</p>
    </li>
  );
}

function Node({ node }: { node: SpecialistNode }) {
  const label = SPECIALIST_LABELS[node.specialist];

  if (node.status === "running") {
    return (
      <section className="border-border bg-surface animate-pulse rounded-lg border p-3">
        <div className="flex items-baseline justify-between">
          <h4 className="text-muted text-xs font-semibold tracking-wide uppercase">
            {label}
          </h4>
          <span className="text-muted text-xs">reading…</span>
        </div>
      </section>
    );
  }

  if (node.status === "failed") {
    // A specialist that failed is a specialist that failed. The others still ran, and
    // their findings are still worth reading — so this is reported in place, rather
    // than replacing the review with an error page.
    return (
      <section className="border-border bg-surface rounded-lg border border-dashed p-3">
        <div className="flex items-baseline justify-between">
          <h4 className="text-muted text-xs font-semibold tracking-wide uppercase">
            {label}
          </h4>
          <span className="text-medium text-xs">failed</span>
        </div>
        <p className="text-muted mt-1.5 text-sm">
          {node.error} The review below does not cover this lens.
        </p>
      </section>
    );
  }

  const findings = [...node.findings].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity],
  );

  return (
    <section className="border-border bg-surface rounded-lg border p-3">
      <div className="flex items-baseline justify-between">
        <h4 className="text-muted text-xs font-semibold tracking-wide uppercase">
          {label}
        </h4>
        <span className="text-muted text-xs">
          {findings.length === 0 ? "nothing to report" : `${findings.length} raised`}
        </span>
      </div>

      {findings.length > 0 && (
        <ul className="mt-1">
          {findings.map((f, i) => (
            <FindingRow key={`${f.line}-${i}`} finding={f} />
          ))}
        </ul>
      )}

      {node.droppedLineRefs > 0 && (
        // Surfaced, not swallowed. A specialist inventing line numbers is a specialist
        // to stop paying for, and that is only visible if it is said out loud.
        <p className="text-muted mt-2 text-xs">
          {node.droppedLineRefs} finding
          {node.droppedLineRefs === 1 ? "" : "s"} discarded for pointing at a line that
          does not exist.
        </p>
      )}
    </section>
  );
}

export default function FindingsPanel({ nodes }: { nodes: SpecialistNode[] }) {
  if (nodes.length === 0) return null;

  return (
    <details className="group" open>
      <summary className="text-muted hover:text-ink cursor-pointer text-xs font-medium">
        What each specialist reported ({nodes.length})
      </summary>

      <div className="mt-2 flex flex-col gap-2">
        {nodes.map((node) => (
          <Node key={node.specialist} node={node} />
        ))}
      </div>
    </details>
  );
}
