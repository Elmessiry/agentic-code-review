// The planner's safety floor.
//
// The planner exists to save money by skipping specialists that would find
// nothing. That is a good trade right up until it skips Security on a file with an
// `eval()` in it, at which point the saving is measured in cents and the cost is a
// missed vulnerability.
//
// So the planner is not trusted with the whole decision. A regex pre-pass runs
// first, and anything it matches FORCES a specialist on. The tripwire can only ever
// ADD to the plan — it has no power to remove. The planner optimises; it is
// structurally incapable of silently dropping a specialist the tripwire wants.
//
// This is deliberately dumb. It is a smoke detector, not a fire marshal: cheap,
// deterministic, no model in the loop, and it fails toward running one more
// specialist than strictly necessary. Every false positive here costs a fraction of
// a cent. Every false negative it prevents costs a CVE.

import type { Specialist } from "./schema";

type Tripwire = {
  specialist: Specialist;
  pattern: RegExp;
  // Shown to the user, so they can see exactly why the planner was overruled.
  because: string;
};

const TRIPWIRES: Tripwire[] = [
  {
    specialist: "security",
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/,
    because: "executes code from a string",
  },
  {
    specialist: "security",
    pattern: /\bchild_process\b|\bexecSync\s*\(|\bspawn\s*\(/,
    because: "spawns a shell process",
  },
  {
    // String-concatenated or interpolated SQL. Matches the shape of the bug, not
    // the library: a SQL keyword next to a `+` or a `${`.
    specialist: "security",
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b[^;'"`]*(?:['"`]\s*\+|\$\{)/i,
    because: "builds SQL by string concatenation",
  },
  {
    specialist: "security",
    pattern: /\bdangerouslySetInnerHTML\b|\.innerHTML\s*=/,
    because: "writes raw HTML into the DOM",
  },
  {
    specialist: "security",
    pattern: /\bprocess\.env\b|\bapi[_-]?key\b|\bsecret\b|\btoken\s*=/i,
    because: "touches secrets or environment configuration",
  },
  {
    specialist: "performance",
    pattern:
      /\b(?:await|query|fetch|execute)\b[^\n]*\n?[^\n]*\bfor\s*\(|\bfor\s*\([^)]*\)\s*\{[^}]*\bawait\b/,
    because: "awaits inside a loop, which is the shape of an N+1",
  },
];

export type Forced = {
  specialist: Specialist;
  because: string;
};

// Scans the code and returns the specialists that must run no matter what the
// planner decides. Deduplicated by specialist — one reason each is enough to
// explain the override; listing five is noise.
export function tripwires(code: string): Forced[] {
  const seen = new Map<Specialist, string>();

  for (const { specialist, pattern, because } of TRIPWIRES) {
    if (!seen.has(specialist) && pattern.test(code)) {
      seen.set(specialist, because);
    }
  }

  return [...seen].map(([specialist, because]) => ({ specialist, because }));
}
