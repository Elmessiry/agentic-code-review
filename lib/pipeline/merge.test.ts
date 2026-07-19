import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeDeterministically } from "./merge";
import type { Finding, Specialist } from "./schema";

// The deterministic merge is the fallback that keeps a review alive when the synthesizer
// dies, and it is the one stage the replayed eval suite cannot reach: a fixture that made
// the synthesizer return unparseable JSON would have to be hand-forged, and even then it
// would prove the fixture, not the merge. So its contract is pinned here instead — worst
// severity wins, sources union, one finding per line, and a verdict that never invents a
// rejection out of arithmetic.

function finding(specialist: Specialist, over: Partial<Finding>): Finding {
  return {
    specialist,
    severity: "medium",
    line: 1,
    issue: `${specialist} issue`,
    suggestion: `${specialist} fix`,
    ...over,
  };
}

test("two lenses on one line collapse to a single finding that unions their sources", () => {
  const { findings } = mergeDeterministically([
    {
      specialist: "security",
      findings: [finding("security", { line: 2, severity: "high" })],
    },
    {
      specialist: "performance",
      findings: [finding("performance", { line: 2, severity: "medium" })],
    },
  ]);

  assert.equal(findings.length, 1);
  assert.deepEqual([...findings[0].sources].sort(), ["performance", "security"]);
});

test("the worst severity wins, and the finding at it speaks for the group", () => {
  const { findings } = mergeDeterministically([
    {
      specialist: "performance",
      findings: [finding("performance", { line: 5, severity: "low" })],
    },
    {
      specialist: "security",
      findings: [
        finding("security", {
          line: 5,
          severity: "high",
          issue: "rce",
          suggestion: "parameterise",
        }),
      ],
    },
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].issue, "rce");
  assert.equal(findings[0].suggestion, "parameterise");
});

test("a merged line is annotated; a lone finding is not", () => {
  const { findings } = mergeDeterministically([
    {
      specialist: "security",
      findings: [
        finding("security", { line: 3 }),
        finding("security", { line: 3, issue: "second" }),
        finding("security", { line: 9 }),
      ],
    },
  ]);

  const line3 = findings.find((f) => f.line === 3);
  const line9 = findings.find((f) => f.line === 9);
  assert.ok(line3?.note?.includes("2 findings"), "note counts every finding on the line");
  assert.equal(line9?.note, undefined);
});

test("findings are ordered by severity, then by line", () => {
  const { findings } = mergeDeterministically([
    {
      specialist: "readability",
      findings: [
        finding("readability", { line: 8, severity: "low" }),
        finding("readability", { line: 2, severity: "high" }),
        finding("readability", { line: 4, severity: "high" }),
        finding("readability", { line: 1, severity: "medium" }),
      ],
    },
  ]);

  assert.deepEqual(
    findings.map((f) => [f.severity, f.line]),
    [
      ["high", 2],
      ["high", 4],
      ["medium", 1],
      ["low", 8],
    ],
  );
});

test("the verdict never rejects, and never approves a flagged line", () => {
  assert.equal(mergeDeterministically([]).verdict, "approve");

  assert.equal(
    mergeDeterministically([
      { specialist: "tests", findings: [finding("tests", { severity: "low" })] },
    ]).verdict,
    "approve",
  );

  // Medium is not low, so the "approve only on low-or-nothing" rule already covers
  // it — but it is worth pinning on its own: a single medium finding is a real place
  // this could regress into a specific carve-out for "just one finding" that the
  // low-severity case above would not catch.
  assert.equal(
    mergeDeterministically([
      {
        specialist: "readability",
        findings: [finding("readability", { severity: "medium" })],
      },
    ]).verdict,
    "changes_requested",
  );

  assert.equal(
    mergeDeterministically([
      { specialist: "security", findings: [finding("security", { severity: "high" })] },
    ]).verdict,
    "changes_requested",
  );
});
