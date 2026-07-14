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

import { SEVERITIES, type Finding } from "./schema";

export type Checked<T> = {
  findings: T[];
  // How many findings were discarded for pointing at a line that does not exist. This
  // is a hallucination rate, and it is worth watching.
  dropped: number;
};

// Generic over the finding, because the specialists are not the only agent that emits
// a line number. The synthesizer re-states the findings it keeps, and re-stating them
// is another opportunity to get the line wrong — a checked number that goes back
// through an unchecked model comes out unchecked.
export function dropImpossibleLines<T extends { line: number }>(
  findings: T[],
  code: string,
): Checked<T> {
  const lines = code.split("\n").length;

  const kept = findings.filter((f) => {
    const valid = Number.isInteger(f.line) && f.line >= 1 && f.line <= lines;
    if (!valid) {
      console.warn(
        "[line-refs] dropped a finding pointing at a line that does not exist",
        JSON.stringify({ lines, finding: f }),
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
//
// Malformed entries are logged, never silently dropped — the same rule
// dropImpossibleLines applies to line numbers. A filter that discards quietly turns
// "the model emitted something outside the schema" into "the specialist found less",
// and those are very different facts.
export function attribute(raw: unknown, specialist: Finding["specialist"]): Finding[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      console.warn(
        "[line-refs] findings was not an array",
        JSON.stringify({ specialist, got: typeof raw }),
      );
    }
    return [];
  }

  // Derived from the same const as the Severity type and the tool schema's enum, so
  // the scale cannot drift apart across its three uses.
  const severities = new Set<string>(SEVERITIES);

  const kept: Finding[] = [];
  for (const f of raw) {
    const valid =
      typeof f === "object" &&
      f !== null &&
      typeof (f as Finding).issue === "string" &&
      typeof (f as Finding).suggestion === "string" &&
      severities.has((f as Finding).severity);

    if (valid) {
      kept.push({ ...(f as Finding), specialist });
    } else {
      console.warn(
        "[line-refs] dropped a finding outside the schema",
        JSON.stringify({ specialist, finding: f }),
      );
    }
  }

  return kept;
}
