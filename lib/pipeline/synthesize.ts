import { streamTool, type Usage } from "@/lib/openrouter";
import { synthesizerMessages } from "@/lib/prompts/synthesizer";
import {
  coerceSpecialists,
  SEVERITIES,
  SYNTHESIS_TOOL,
  VERDICTS,
  type Finding,
  type Specialist,
  type Synthesis,
  type SynthesizedFinding,
  type Verdict,
} from "./schema";
import { dropImpossibleLines } from "./line-refs";
import { recoverLeakedFields } from "@/lib/partial-json";

// The last agent in the pipeline: turns four partial reviews into one.
//
// It streams, and it is the only step that does. It is also the only step whose output
// a human reads word by word rather than glances at as a list, which is the same fact
// twice: the planner's decision and the specialists' findings are structures that are
// either there or not, but a summary that appears fifteen seconds after you asked for
// it feels broken even when it is perfect.
//
// It does NOT get a cache breakpoint, and the reason generalises. Caching pays when
// several calls share a prefix — that is why the specialists cache, and it is why the
// fan-out is shaped the way it is. There is exactly one synthesis call per review, so
// on an explicit-cache model a breakpoint here would buy a 1.25x write premium and
// find no reader to amortise it against. The cache is a fan-out optimisation, not a
// decoration to sprinkle on every request.
export async function synthesize(
  code: string,
  results: { specialist: Specialist; findings: Finding[] }[],
  failed: Specialist[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ synthesis: Synthesis; usage: Usage }> {
  const { args, usage } = await streamTool<{
    summary?: unknown;
    findings?: unknown;
    verdict?: unknown;
  }>(
    {
      role: "synthesizer",
      messages: synthesizerMessages(code, results, failed),
      tool: SYNTHESIS_TOOL,
      // The field whose prose is decoded out of the still-arriving JSON and forwarded
      // to the browser. It is first in SYNTHESIS_TOOL's schema for exactly this reason.
      streamField: "summary",
      signal,
    },
    onDelta,
  );

  // The raw summary, which is where a leaking provider hides the fields it failed to
  // serialise. See recoverLeakedFields: when the leak happens, `verdict` is not missing —
  // it is sitting inside the summary text, in the format the model actually wrote it in.
  const rawSummary = typeof args.summary === "string" ? args.summary : "";
  const leaked = recoverLeakedFields(rawSummary);

  if (Object.keys(leaked).length > 0) {
    console.warn(
      "[synthesize] the provider leaked its tool-call syntax into the summary",
      JSON.stringify({ recovered: Object.keys(leaked) }),
    );
  }

  // Every specialist that actually produced a report. A source outside this set is a
  // fabrication — the synthesizer crediting a finding to a lens that never ran, which
  // would put a name on the page that contradicts the failure card right next to it.
  const ran = new Set<Specialist>(results.map((r) => r.specialist));

  const findings = validFindings(args.findings, ran);

  // The synthesizer copies line numbers rather than counting them, so this should never
  // fire. It is checked anyway: "should never fire" is what everyone said about the
  // specialists' line numbers too, and a number that has passed through a language
  // model has been laundered, not verified.
  const checked = dropImpossibleLines(findings, code);

  return {
    synthesis: {
      // Truncated at the leak, exactly as the streamed copy was — otherwise the summary
      // the user reads and the summary the page settles on would differ, and the page
      // would be the one with the XML in it.
      summary: rawSummary.split("</summary>")[0].trim(),
      findings: checked.findings,
      // The verdict the model chose, wherever it ended up: as a real JSON key, or trapped
      // inside the summary by a provider that could not serialise its own tool call.
      // Defaulting to changes_requested is the right thing to do when there is no verdict;
      // it is the wrong thing to do when there is one and we simply did not look.
      verdict: validVerdict(args.verdict ?? leaked.verdict),
    },
    usage,
  };
}

function validFindings(raw: unknown, ran: Set<Specialist>): SynthesizedFinding[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      console.warn("[synthesize] findings was not an array", JSON.stringify({ raw }));
    }
    return [];
  }

  const severities = new Set<string>(SEVERITIES);
  const kept: SynthesizedFinding[] = [];

  for (const f of raw) {
    const finding = f as Partial<SynthesizedFinding>;
    const { severity, line, issue, suggestion, note } = finding;

    if (
      typeof f !== "object" ||
      f === null ||
      typeof issue !== "string" ||
      typeof suggestion !== "string" ||
      typeof severity !== "string" ||
      !severities.has(severity)
    ) {
      console.warn(
        "[synthesize] dropped a finding outside the schema",
        JSON.stringify(f),
      );
      continue;
    }

    const { agents, dropped } = coerceSpecialists(finding.sources);
    // Sources are attribution, and attribution has to be true. A hallucinated source
    // is not a cosmetic error: it is the review claiming a lens looked at something it
    // did not, which is the one lie this design exists to make impossible.
    const sources = agents.filter((s) => ran.has(s));

    if (dropped.length > 0 || sources.length !== agents.length) {
      console.warn(
        "[synthesize] discarded sources that no specialist produced",
        JSON.stringify({ claimed: finding.sources, kept: sources }),
      );
    }

    kept.push({
      severity: severity as SynthesizedFinding["severity"],
      line: line as number,
      issue,
      suggestion,
      sources,
      ...(typeof note === "string" && note.trim().length > 0
        ? { note: note.trim() }
        : {}),
    });
  }

  return kept;
}

// A verdict outside the enum is a model that ignored a constrained field. Failing
// closed — to the verdict that asks a human to look — is the only safe direction: the
// alternative defaults a review nobody can parse to "approve".
function validVerdict(raw: unknown): Verdict {
  const verdicts = new Set<string>(VERDICTS);

  if (typeof raw === "string" && verdicts.has(raw)) return raw as Verdict;

  // Seen live: the synthesizer closed its object without ever writing `verdict`, despite
  // the field being required by the schema. `required` is a strong hint to a model, not a
  // guarantee — so log what it DID send, because "undefined" alone tells you nothing about
  // which field went missing or why.
  console.warn("[synthesize] verdict outside the schema", JSON.stringify({ raw }));
  return "changes_requested";
}
