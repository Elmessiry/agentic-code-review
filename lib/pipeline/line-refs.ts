// Catches findings anchored to lines that do not exist.
//
// Models are bad at counting lines. We remove most of the guesswork by numbering the
// code for them, but numbering it does not make them infallible — a model that is
// confident about a bug and vague about where it lives will still produce a plausible
// integer. That integer is the most dangerous thing in the finding: a reader who follows
// a line number to the wrong line does not conclude "the line number is wrong", they
// conclude "this tool is wrong", and they are right to.
//
// So every line reference is checked against the real file. A finding pointing past the
// end of the code is not shown. The count of what got dropped is kept and surfaced,
// because a specialist that keeps inventing line numbers is a specialist to stop paying
// for, and that is only visible if the number is reported rather than swept up.

import type { Finding } from "./schema";

export type Checked = {
  findings: Finding[];
  // How many findings were discarded for pointing at a line that does not exist. This
  // is a hallucination rate, and it is worth watching.
  dropped: number;
};

export function dropImpossibleLines(findings: Finding[], code: string): Checked {
  const lines = code.split("\n").length;

  const kept = findings.filter((f) => {
    const valid = Number.isInteger(f.line) && f.line >= 1 && f.line <= lines;
    if (!valid) {
      console.warn(
        "[line-refs] dropped a finding pointing at a line that does not exist",
        JSON.stringify({ line: f.line, lines, specialist: f.specialist, issue: f.issue }),
      );
    }
    return valid;
  });

  return { findings: kept, dropped: findings.length - kept.length };
}

// The model returns findings without knowing which specialist it is; the specialist is
// context we already hold. Stamping it here — rather than asking the model to repeat it
// back — removes a field it could get wrong, and there is no reason to let a model
// misattribute a finding to a colleague.
export function attribute(raw: unknown, specialist: Finding["specialist"]): Finding[] {
  if (!Array.isArray(raw)) return [];

  const severities = new Set(["high", "medium", "low"]);

  return raw
    .filter(
      (f): f is Finding =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as Finding).issue === "string" &&
        typeof (f as Finding).suggestion === "string" &&
        severities.has((f as Finding).severity),
    )
    .map((f) => ({ ...f, specialist }));
}
