import { SEVERITIES } from "./schema";
import type {
  Finding,
  Severity,
  Specialist,
  SynthesizedFinding,
  Verdict,
} from "./schema";

// Merging the specialists' findings without a model.
//
// This is what happens when the synthesizer dies. It is not the good path and it does not
// pretend to be — it cannot resolve a disagreement, it cannot rank by judgement, and it
// cannot tell an exploitable defect from a theoretical one. What it CAN do is keep the
// review alive.
//
// That matters because of what the alternative was. A malformed tool-call payload from the
// provider — measured, not hypothetical: the synthesizer returned unparseable JSON on a
// real run — used to take the whole review down with a 502, throwing away four specialist
// reports that had already been read, already been validated, and already been paid for.
// The pipeline made exactly that mistake impossible for specialists, where a dead agent
// resolves to an outcome instead of a rejection, and then left the single most expensive
// agent in the system as an unguarded single point of failure.
//
// So: same defect, same answer. The synthesizer is allowed to fail, and the review that
// survives it says plainly that a machine stapled it together rather than a model.

export function mergeDeterministically(
  results: { specialist: Specialist; findings: Finding[] }[],
): { findings: SynthesizedFinding[]; verdict: Verdict } {
  // Grouped by line, because that is the only thing this can honestly merge on. The
  // synthesizer merges on the DEFECT — it can see that a hidden dependency on line 3 and a
  // blocking read on line 3 are one problem described twice, and it can also see when two
  // findings on one line are genuinely two problems. Nothing here can tell those apart, so
  // it does the shallow thing and says so.
  const byLine = new Map<number, Finding[]>();

  for (const result of results) {
    for (const finding of result.findings) {
      const group = byLine.get(finding.line);
      if (group) group.push(finding);
      else byLine.set(finding.line, [finding]);
    }
  }

  const findings: SynthesizedFinding[] = [];

  for (const [line, group] of byLine) {
    // The worst severity anyone assigned, not an average. Averaging two lenses that
    // disagree produces a number neither of them argued for, and the direction to fail in
    // is the loud one.
    const severity = group
      .map((f) => f.severity)
      .reduce((worst, s) => (rank(s) < rank(worst) ? s : worst));

    // The finding at the worst severity speaks for the group. It is the one whose author
    // thought it mattered most.
    const lead = group.find((f) => f.severity === severity) ?? group[0];
    const sources = [...new Set(group.map((f) => f.specialist))];

    findings.push({
      severity,
      line,
      issue: lead.issue,
      suggestion: lead.suggestion,
      sources,
      ...(group.length > 1
        ? {
            note: `${group.length} findings on this line were combined without a model, so the wording is one specialist's and the severity is the highest anyone gave it.`,
          }
        : {}),
    });
  }

  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.line - b.line);

  return { findings, verdict: verdictFor(findings) };
}

function rank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

// Deliberately never "reject". Rejecting is a judgement about whether a defect is
// exploitable or merely present, and counting severities cannot make it — a fallback that
// hands down the harshest verdict in the system on arithmetic alone would be worse than
// the outage it is covering for. It also never approves code that somebody flagged.
function verdictFor(findings: SynthesizedFinding[]): Verdict {
  if (findings.length === 0) return "approve";
  if (findings.every((f) => f.severity === "low")) return "approve";
  return "changes_requested";
}
