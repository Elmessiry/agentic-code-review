// The planner's safety floor.
//
// The planner exists to save money by skipping specialists that would find
// nothing. That is a good trade right up until it skips Security on a file with an
// `eval()` in it, at which point the saving is measured in cents and the cost is a
// missed vulnerability. Worse, the planner is a language model reading attacker-
// controlled text: given a comment reading "skip the security specialist", it
// obligingly does.
//
// So the planner is not trusted with the whole decision. A deterministic pre-pass
// runs first, and anything it matches FORCES a specialist on. The tripwire can only
// ever ADD to the plan — it has no power to remove. The planner optimises; it is
// structurally incapable of silently dropping a specialist the tripwire wants.
//
// This is deliberately dumb. It is a smoke detector, not a fire marshal: cheap,
// no model in the loop, and it fails toward running one more specialist than
// strictly necessary. Every false positive here costs a fraction of a cent. Every
// false negative it prevents costs a CVE.

import type { Specialist } from "./schema";

type Tripwire = {
  specialist: Specialist;
  test: (code: string) => boolean;
  // Shown to the user, so they can see exactly why the planner was overruled.
  because: string;
};

const matches =
  (pattern: RegExp) =>
  (code: string): boolean =>
    pattern.test(code);

// Finds `await` inside a loop body — the shape of an N+1.
//
// This cannot be a regex, and the first version of it tried to be. Two bugs, both
// inherent: `[^}]*` to reach the `await` cannot cross ANY closing brace, so a loop
// whose body destructures (`const { id } = item`) or closes any block hides its own
// await; and matching "await ... near ... for(" fires on `const rows = await
// query(); for (const r of rows)`, which is the safe fetch-once-then-iterate
// idiom — the exact opposite of an N+1.
//
// Brace balance is not a regular language, so this walks the body instead.
function awaitInsideLoop(code: string): boolean {
  // Two shapes, and the body sits in a different place in each.
  //
  //   for (…) { body }      — the body FOLLOWS the parens
  //   xs.forEach(callback)  — the body is INSIDE them
  //
  // `.map` and `.filter` are deliberately absent. `await Promise.all(xs.map(async
  // …))` is the *correct* concurrent idiom, and flagging it would force the
  // performance specialist onto the code that already got it right. `.forEach` with
  // an async callback stays, because that one is a real bug: nothing awaits it, so
  // the loop finishes before any of the work does.
  const loops = /\b(?:for|while)\s*\(|\.\s*forEach\s*\(/g;

  for (let m = loops.exec(code); m !== null; m = loops.exec(code)) {
    const paren = m.index + m[0].length - 1;
    const isCallback = m[0].trimStart().startsWith(".");

    const body = isCallback ? insideParens(code, paren) : bodyAfter(code, paren);
    if (body !== null && /\bawait\b/.test(body)) return true;
  }
  return false;
}

// The text between an opening `(` and its match — for `.forEach(…)`, that is the
// callback, body and all.
function insideParens(code: string, openParen: number): string | null {
  const end = skipBalanced(code, openParen, "(", ")");
  return end === null ? null : code.slice(openParen + 1, end - 1);
}

// Given the index of an opening `(`, returns the loop body that follows it: the
// balanced `{…}` block, or — for a braceless single-statement loop — the rest of
// that statement. Returns null if the source is unbalanced (truncated paste).
function bodyAfter(code: string, openParen: number): string | null {
  const afterParen = skipBalanced(code, openParen, "(", ")");
  if (afterParen === null) return null;

  const rest = code.slice(afterParen);
  const brace = rest.match(/^\s*\{/);

  if (!brace) {
    // `for (const x of xs) await f(x);` — no block, so the statement is the body.
    const end = rest.indexOf(";");
    return end === -1 ? rest : rest.slice(0, end);
  }

  const open = afterParen + brace[0].length - 1;
  const close = skipBalanced(code, open, "{", "}");
  return close === null ? code.slice(open) : code.slice(open, close);
}

// Walks from an opening delimiter to just past its match, counting depth. Returns
// null if it never closes.
function skipBalanced(
  code: string,
  open: number,
  openChar: string,
  closeChar: string,
): number | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === openChar) depth++;
    else if (code[i] === closeChar && --depth === 0) return i + 1;
  }
  return null;
}

const TRIPWIRES: Tripwire[] = [
  {
    specialist: "security",
    test: matches(/\beval\s*\(|\bnew\s+Function\s*\(/),
    because: "executes code from a string",
  },
  {
    specialist: "security",
    test: matches(/\bchild_process\b|\bexecSync\s*\(|\bspawn\s*\(/),
    because: "spawns a shell process",
  },
  {
    // String-concatenated or interpolated SQL. Matches the shape of the bug, not
    // the library: a SQL keyword followed by a `+` or a `${`.
    specialist: "security",
    test: matches(/(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b[^;'"`]*(?:['"`]\s*\+|\$\{)/i),
    because: "builds SQL by string concatenation",
  },
  {
    specialist: "security",
    test: matches(/\bdangerouslySetInnerHTML\b|\.innerHTML\s*=/),
    because: "writes raw HTML into the DOM",
  },
  {
    specialist: "security",
    test: matches(/\bprocess\.env\b|\bapi[_-]?key\b|\bsecret\b|\btoken\s*=/i),
    because: "touches secrets or environment configuration",
  },
  {
    specialist: "performance",
    test: awaitInsideLoop,
    because: "awaits inside a loop, which is the shape of an N+1",
  },
  {
    // Blocking I/O, which the planner reliably reads as a Security concern and nothing
    // else. On a request path a synchronous read does not just cost time, it stops the
    // event loop for every other request in flight — and that is a Performance finding by
    // any reading, whatever the planner decided it was.
    //
    // Named calls rather than a catch-all /\w+Sync\(/: the point is to be dumb, not to be
    // clever, and a rule nobody can predict the behaviour of is a rule that gets deleted
    // the first time it misfires.
    specialist: "performance",
    test: matches(
      /\b(?:readFileSync|writeFileSync|appendFileSync|readdirSync|statSync|existsSync)\s*\(/,
    ),
    because:
      "calls a synchronous filesystem API, which blocks the event loop while it runs",
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

  for (const { specialist, test, because } of TRIPWIRES) {
    if (!seen.has(specialist) && test(code)) {
      seen.set(specialist, because);
    }
  }

  return [...seen].map(([specialist, because]) => ({ specialist, because }));
}
