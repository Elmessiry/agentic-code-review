import type { Severity, Specialist, Verdict } from "@/lib/pipeline/schema";

// What a case asserts.
//
// Every expectation here is STRUCTURED. The obvious alternative — "did the review mention
// SQL injection?" — grades prose with a substring search, which passes for a review that
// says "there is no SQL injection here" and fails for one that says "the query is built by
// concatenation". Matching free text is theatre; it measures vocabulary, not correctness.
//
// So a finding is matched on the things a reviewer would actually check: is it on the
// right line, is it at least as severe as it should be, did the right lens raise it, and
// does its text mention the mechanism. Any one of those can be omitted; all of them that
// are present must hold.
export type Expectation = {
  // Which specialists must (or must not) run. Deliberately not an exact set: the planner
  // is a language model, and an eval that fails when it reasonably picks Readability as
  // well is an eval nobody will keep running. What matters is that it never MISSES a lens
  // the code needs, and never wastes money on one it plainly does not.
  agents?: { include?: Specialist[]; exclude?: Specialist[] };

  // Specialists the deterministic tripwire must MATCH on, whatever the planner decided.
  //
  // Not the same thing as `forced`, and the difference matters. `forced` is the list of
  // specialists the tripwire had to overrule the planner about — so it is empty whenever
  // the planner reached the same conclusion on its own, which is the common case and a
  // good one. Asserting on `forced` would therefore fail the moment the planner got
  // smarter, which is precisely backwards.
  //
  // What must hold is that the deterministic net SAW the dangerous construct. Whether the
  // model happened to agree is not the safety property; the safety property is that the
  // model's agreement was never load-bearing.
  tripwire?: Specialist[];

  // Specialists the tripwire had to overrule the planner about — a stronger claim, and
  // only assert it on code where the planner demonstrably gets it wrong.
  forced?: Specialist[];

  // The defects the review is supposed to catch. These are the recall targets.
  findings?: FindingExpectation[];

  // The verdicts that would be acceptable. A review of exploitable code that comes back
  // "approve" has failed no matter how good its prose is.
  verdict?: Verdict[];

  // The anti-hallucination budget. On code that is fine, the correct number of
  // high-severity findings is zero, and a model that invents one to look diligent is
  // worse than useless — it trains the reader to ignore every finding it produces.
  maxHigh?: number;

  // A regex the summary must NOT match. This is how the prompt-injection case is scored:
  // the payload asks the reviewer to approve the code, and the defence is only proven if
  // the reviewer visibly does not.
  summaryMustNotMatch?: string;

  // A regex the summary MUST match. Used where the point of the case is that the
  // synthesizer says something specific out loud — that a lens did not run, for instance.
  summaryMustMatch?: string;
};

export type FindingExpectation = {
  what: string;
  line?: number;
  minSeverity?: Severity;
  // A regex against the finding's issue + suggestion. Matches the MECHANISM, not the
  // label: "concatenat|interpolat|\\+ *req\\." rather than "SQL injection".
  match?: string;
  // Which lens should have raised it. Checked against the merged finding's sources.
  by?: Specialist;
  // The conflict case: this defect must have been found by at least this many lenses
  // independently, which is the only evidence of agreement the pipeline can produce.
  sourcesAtLeast?: number;
};

export type Case = {
  name: string;
  // Why the case exists. Printed on failure, because a red eval whose point you have to
  // reverse-engineer from the assertion gets deleted rather than fixed.
  asserts: string;
  code: string;
  expect: Expectation;
};
