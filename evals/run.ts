import { readdir, readFile } from "node:fs/promises";
import { runReview } from "@/lib/pipeline/review";
import { SEVERITIES } from "@/lib/pipeline/schema";
import type {
  ReviewCost,
  ReviewEvent,
  Specialist,
  SynthesizedFinding,
  Verdict,
} from "@/lib/pipeline/schema";
import { record, replay } from "./cassette";
import type { Case, FindingExpectation } from "./types";

// Scores the pipeline on recall, false positives, schema conformance and real cost.
//
// Recall alone is a trap: a reviewer that flags every line of every file has perfect
// recall and is worthless, because a finding list nobody reads catches nothing. So the
// suite carries a false-positive budget, and the clean case — code that is genuinely fine
// — is the one whose result matters most. Zero high-severity findings, or the run fails.
//
//   npm run eval             replay the recorded calls (free, deterministic, what CI runs)
//   npm run eval -- --live   hit the real API
//   npm run eval -- --record hit the real API and save the responses as fixtures

const THRESHOLDS = {
  recall: 0.8,
  falsePositives: 0,
  schemaConformance: 0.98,
};

type Transcript = {
  agents: Specialist[];
  forced: Specialist[];
  // Every specialist the tripwire matched, whether or not the planner had to be overruled
  // about it. This is the deterministic net's own record, independent of the model.
  tripwire: Specialist[];
  results: { specialist: Specialist; findings: number; dropped: number }[];
  failures: Specialist[];
  rawFindings: number;
  droppedLineRefs: number;
  summary: string;
  findings: SynthesizedFinding[];
  verdict: Verdict | null;
  cost: ReviewCost;
};

async function transcribe(code: string): Promise<Transcript> {
  const t: Transcript = {
    agents: [],
    forced: [],
    tripwire: [],
    results: [],
    failures: [],
    rawFindings: 0,
    droppedLineRefs: 0,
    summary: "",
    findings: [],
    verdict: null,
    cost: { planUsd: 0, specialistsUsd: 0, synthesisUsd: 0, totalUsd: 0 },
  };

  const collect = (event: ReviewEvent) => {
    switch (event.type) {
      case "plan":
        t.agents = event.plan.agents;
        t.forced = event.plan.forced;
        t.tripwire = Object.keys(event.plan.overrides) as Specialist[];
        break;
      case "specialist_done":
        t.results.push({
          specialist: event.specialist,
          findings: event.findings.length,
          dropped: event.droppedLineRefs,
        });
        t.rawFindings += event.findings.length;
        t.droppedLineRefs += event.droppedLineRefs;
        break;
      case "specialist_error":
        t.failures.push(event.specialist);
        break;
      case "synthesis_delta":
        t.summary += event.text;
        break;
      case "synthesis_done":
        t.findings = event.findings;
        t.verdict = event.verdict;
        break;
      case "done":
        t.cost = event.cost;
        break;
      case "specialist_start":
      case "error":
        break;
    }
  };

  await runReview(code, collect);
  return t;
}

type Check = { ok: boolean; label: string; detail?: string };

// Does any merged finding match this expectation? Every field that is present must hold —
// line, severity floor, the lens that raised it, and a regex against the finding's text.
// The regex matches the MECHANISM ("concatenat|parameteri"), never the label ("SQL
// injection"), because a review that says "there is no SQL injection here" contains the
// label too.
function matches(finding: SynthesizedFinding, want: FindingExpectation): boolean {
  if (want.line !== undefined && finding.line !== want.line) return false;

  if (want.minSeverity !== undefined) {
    const floor = SEVERITIES.indexOf(want.minSeverity);
    if (SEVERITIES.indexOf(finding.severity) > floor) return false;
  }

  if (want.by !== undefined && !finding.sources.includes(want.by)) return false;

  if (want.sourcesAtLeast !== undefined && finding.sources.length < want.sourcesAtLeast) {
    return false;
  }

  if (want.match !== undefined) {
    const text = `${finding.issue} ${finding.suggestion}`;
    if (!new RegExp(want.match, "i").test(text)) return false;
  }

  return true;
}

function score(c: Case, t: Transcript) {
  const checks: Check[] = [];
  let expected = 0;
  let recalled = 0;
  let falsePositives = 0;

  const e = c.expect;

  for (const agent of e.agents?.include ?? []) {
    checks.push({
      ok: t.agents.includes(agent),
      label: `runs ${agent}`,
      detail: `ran: ${t.agents.join(", ") || "nobody"}`,
    });
  }

  for (const agent of e.agents?.exclude ?? []) {
    checks.push({
      ok: !t.agents.includes(agent),
      label: `does not waste money on ${agent}`,
      detail: `ran: ${t.agents.join(", ") || "nobody"}`,
    });
  }

  for (const agent of e.tripwire ?? []) {
    checks.push({
      ok: t.tripwire.includes(agent),
      label: `tripwire matches ${agent}`,
      detail: `tripwire matched: ${t.tripwire.join(", ") || "nothing"}`,
    });
  }

  for (const agent of e.forced ?? []) {
    checks.push({
      ok: t.forced.includes(agent),
      label: `tripwire overrules the planner on ${agent}`,
      detail: `overruled: ${t.forced.join(", ") || "nobody"}`,
    });
  }

  for (const want of e.findings ?? []) {
    expected++;
    const found = t.findings.some((f) => matches(f, want));
    if (found) recalled++;
    checks.push({
      ok: found,
      label: `finds: ${want.what}`,
      detail: found
        ? undefined
        : `got ${t.findings.length} findings: ${
            t.findings.map((f) => `[${f.severity}] L${f.line}`).join(" ") || "none"
          }`,
    });
  }

  if (e.maxHigh !== undefined) {
    const high = t.findings.filter((f) => f.severity === "high");
    // Every high-severity finding on code declared clean is a false positive, and the
    // false-positive budget is what stops recall being gamed by a model that flags
    // everything it sees.
    const over = Math.max(0, high.length - e.maxHigh);
    falsePositives += over;
    checks.push({
      ok: over === 0,
      label: `at most ${e.maxHigh} high-severity finding${e.maxHigh === 1 ? "" : "s"}`,
      detail: high.map((f) => `L${f.line}: ${f.issue}`).join(" | ") || undefined,
    });
  }

  if (e.verdict !== undefined) {
    checks.push({
      ok: t.verdict !== null && e.verdict.includes(t.verdict),
      label: `verdict is one of ${e.verdict.join(" / ")}`,
      detail: `got: ${t.verdict ?? "none"}`,
    });
  }

  if (e.summaryMustNotMatch !== undefined) {
    const hit = new RegExp(e.summaryMustNotMatch, "i").exec(t.summary);
    checks.push({
      ok: hit === null,
      label: "the summary does not obey the injected instruction",
      detail: hit ? `summary contains "${hit[0]}"` : undefined,
    });
  }

  if (e.summaryMustMatch !== undefined) {
    checks.push({
      ok: new RegExp(e.summaryMustMatch, "i").test(t.summary),
      label: "the summary says what it must",
    });
  }

  return { checks, expected, recalled, falsePositives };
}

async function main() {
  const args = process.argv.slice(2);
  const recording = args.includes("--record");
  const live = recording || args.includes("--live");

  let save: (() => Promise<number>) | null = null;

  if (recording) {
    save = record();
    console.log("recording live calls to evals/fixtures/calls.json\n");
  } else if (!live) {
    const n = await replay();
    console.log(`replaying ${n} recorded calls — no network, no spend\n`);
  } else {
    console.log("running live against the real API\n");
  }

  const files = (await readdir("evals/cases")).filter((f) => f.endsWith(".json")).sort();

  let expected = 0;
  let recalled = 0;
  let falsePositives = 0;
  let rawFindings = 0;
  let dropped = 0;
  let cost = 0;
  let failedCases = 0;

  for (const file of files) {
    const c: Case = JSON.parse(await readFile(`evals/cases/${file}`, "utf8"));

    const started = Date.now();
    const t = await transcribe(c.code);
    const ms = Date.now() - started;

    const s = score(c, t);

    expected += s.expected;
    recalled += s.recalled;
    falsePositives += s.falsePositives;
    rawFindings += t.rawFindings;
    dropped += t.droppedLineRefs;
    cost += t.cost.totalUsd;

    const bad = s.checks.filter((x) => !x.ok);
    if (bad.length > 0) failedCases++;

    console.log(
      `${bad.length === 0 ? "PASS" : "FAIL"}  ${c.name.padEnd(17)}` +
        `${t.agents.join("+") || "no specialists"}` +
        `  ${t.findings.length} findings  ${t.verdict ?? "-"}` +
        `  $${t.cost.totalUsd.toFixed(5)}  ${(ms / 1000).toFixed(1)}s`,
    );

    for (const check of s.checks) {
      if (!check.ok) {
        console.log(`        ✗ ${check.label}`);
        if (check.detail) console.log(`          ${check.detail}`);
      }
    }
    if (bad.length > 0) console.log(`        why this case exists: ${c.asserts}\n`);
  }

  const recallRate = expected === 0 ? 1 : recalled / expected;
  const conformance = rawFindings === 0 ? 1 : 1 - dropped / (rawFindings + dropped);

  console.log("\n" + "─".repeat(64));
  console.log(
    `recall              ${(recallRate * 100).toFixed(0)}%  (${recalled}/${expected} defects found)`,
  );
  console.log(
    `false positives     ${falsePositives}  (high-severity findings on clean code)`,
  );
  console.log(
    `schema conformance  ${(conformance * 100).toFixed(1)}%  (${dropped} line refs pointed nowhere)`,
  );
  console.log(
    `cost                $${cost.toFixed(5)} for ${files.length} reviews${live ? "" : " (as recorded)"}`,
  );
  console.log("─".repeat(64));

  if (save) {
    const n = await save();
    console.log(`\nrecorded ${n} calls to evals/fixtures/calls.json`);
  }

  const failures = [
    failedCases > 0 && `${failedCases} case${failedCases === 1 ? "" : "s"} failed`,
    recallRate < THRESHOLDS.recall &&
      `recall ${(recallRate * 100).toFixed(0)}% is under the ${THRESHOLDS.recall * 100}% threshold`,
    falsePositives > THRESHOLDS.falsePositives &&
      `${falsePositives} false positive${falsePositives === 1 ? "" : "s"} — the budget is ${THRESHOLDS.falsePositives}`,
    conformance < THRESHOLDS.schemaConformance &&
      `schema conformance ${(conformance * 100).toFixed(1)}% is under the ${THRESHOLDS.schemaConformance * 100}% threshold`,
  ].filter(Boolean);

  if (failures.length > 0) {
    console.log(`\n${failures.map((f) => `✗ ${f}`).join("\n")}`);
    process.exit(1);
  }

  console.log("\n✓ every case passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
