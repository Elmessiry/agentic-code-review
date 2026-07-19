// The contract every agent in the pipeline speaks.
//
// Agents hand work to each other. The planner tells the specialists what to run,
// the specialists tell the synthesizer what they found. Those hand-offs are the
// place a multi-agent system usually rots: one agent starts emitting prose where
// the next expects a field, and the failure is silent because everything is a
// string. Forcing every step through a schema — via tool calls, not "please reply
// in JSON" — is what keeps the seams honest.

export const SPECIALISTS = ["security", "performance", "readability", "tests"] as const;

export type Specialist = (typeof SPECIALISTS)[number];

export const SPECIALIST_LABELS: Record<Specialist, string> = {
  security: "Security",
  performance: "Performance",
  readability: "Readability",
  tests: "Test Coverage",
};

// What each specialist is actually for. This doubles as the planner's menu — it is
// interpolated into the planner prompt, so the descriptions the planner routes on
// are the same ones written here, and they cannot drift apart.
export const SPECIALIST_BRIEFS: Record<Specialist, string> = {
  security:
    "Injection, authentication and authorisation flaws, unsafe deserialisation, secrets in source, unvalidated input reaching a dangerous sink.",
  performance:
    "Algorithmic complexity, N+1 queries, work repeated in a loop, blocking calls on a hot path, memory held longer than needed.",
  readability:
    "Naming, dead code, tangled control flow, missing or misleading abstractions. Not formatting — a linter handles that.",
  tests:
    "Whether the code is testable and what a test would need to assert. Missing edge cases, untestable coupling, absent error-path coverage.",
};

// The single source for the severity scale. The type, the tool schema's enum, and
// the runtime validation in line-refs.ts all derive from this array — three sites
// that once spelled the literals independently, where adding a severity to two of
// them would have made every finding at the new level silently vanish in the third.
export const SEVERITIES = ["high", "medium", "low"] as const;

export type Severity = (typeof SEVERITIES)[number];

export type Finding = {
  specialist: Specialist;
  severity: Severity;
  // 1-indexed, and validated against the real line count before it is trusted —
  // models invent line numbers, so an unchecked one is a guess wearing a suit.
  line: number;
  issue: string;
  suggestion: string;
};

export type Plan = {
  // Who will actually run: the planner's picks, plus anything the tripwire forced
  // on top. This is the union, already resolved.
  agents: Specialist[];
  // Who the planner chose to skip, and who it was overruled about. Both are shown
  // in the UI: a planner whose skips are invisible is indistinguishable from a
  // planner that does nothing.
  skipped: Specialist[];
  forced: Specialist[];
  reasoning: string;
};

// The tool the planner is forced to call. OpenRouter passes `tools` and
// `tool_choice` through to every vendor here, so "return this shape" is enforced by
// the API rather than requested in a prompt and hoped for.
export const PLANNER_TOOL = {
  type: "function" as const,
  function: {
    name: "select_specialists",
    description:
      "Choose which review specialists are relevant to this code, and explain why.",
    parameters: {
      type: "object",
      properties: {
        relevant_agents: {
          type: "array",
          items: { type: "string", enum: [...SPECIALISTS] },
          description:
            "The specialists worth running. Omit any that would find nothing — that is the point of this step.",
        },
        reasoning: {
          type: "string",
          description:
            "One or two sentences: why these, and why not the others. This is shown to the user, so it must be specific to the code, not generic.",
        },
      },
      required: ["relevant_agents", "reasoning"],
      additionalProperties: false,
    },
  },
};

export const VERDICTS = ["approve", "changes_requested", "reject"] as const;

export type Verdict = (typeof VERDICTS)[number];

// What the synthesizer produces: one finding, after the duplicates have been merged.
//
// `sources` is the whole point. Four specialists reading the same twelve lines will
// independently raise the same defect in four different vocabularies, and a flat list
// shows it four times as though it were four problems. Merging them into one finding
// that names who raised it turns the duplication from noise into evidence — a defect
// three specialists found through three different lenses is likelier to be real than
// one that only a single lens saw.
export type SynthesizedFinding = {
  severity: Severity;
  line: number;
  issue: string;
  suggestion: string;
  sources: Specialist[];
  // Set only where the specialists actually disagreed — most often about severity,
  // because the same defect is a denial-of-service to Security and a hot-path cost to
  // Performance. This is where the disagreement gets named and settled, rather than
  // averaged away into a number nobody argued for.
  note?: string;
};

export type Synthesis = {
  summary: string;
  findings: SynthesizedFinding[];
  verdict: Verdict;
};

// The tool the synthesizer is forced to call.
//
// The property ORDER here is load-bearing, which is not something a JSON schema
// usually gets to say. Models emit properties in the order the schema declares them,
// and the arguments of a forced tool call stream back as raw JSON fragments — so
// `summary` first is what lets its prose be decoded out of the half-written object and
// forwarded to the browser while the findings are still being written. Move it below
// `findings` and the review still works, but the user watches a spinner until the
// whole object lands. See streamTool() in lib/openrouter.ts.
export const SYNTHESIS_TOOL = {
  type: "function" as const,
  function: {
    name: "write_review",
    description:
      "Merge the specialists' findings into one review: dedupe, resolve their disagreements, rank, and give a verdict.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Two to four sentences of plain prose, addressed to the author. Lead with what actually matters. If the specialists disagreed, say so and say how you settled it. No headings, no bullets, no restating the finding list.",
        },
        findings: {
          type: "array",
          description:
            "The merged findings, most severe first. Fewer than you were given: duplicates become one finding with several sources.",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: [...SEVERITIES],
                description:
                  "Your judgement, not an average of theirs. Where they disagreed, pick one and justify it in `note`.",
              },
              line: {
                type: "integer",
                description:
                  "The 1-indexed line, copied from the finding you are merging. Do not renumber, do not guess.",
              },
              issue: {
                type: "string",
                description:
                  "What is wrong, in one sentence. If several specialists saw it differently, state the defect once, in the terms that matter most.",
              },
              suggestion: { type: "string", description: "The concrete fix." },
              sources: {
                type: "array",
                items: { type: "string", enum: [...SPECIALISTS] },
                description:
                  "Every specialist that raised this defect. More than one is agreement, and agreement is evidence.",
              },
              note: {
                type: "string",
                description:
                  "Only when the specialists disagreed: name the disagreement and say why you settled it this way. Omit entirely otherwise — an empty note on every finding is noise.",
              },
            },
            required: ["severity", "line", "issue", "suggestion", "sources"],
            additionalProperties: false,
          },
        },
        verdict: {
          type: "string",
          enum: [...VERDICTS],
          description:
            "approve: nothing here blocks a merge. changes_requested: a real defect a reviewer would want fixed first. reject: exploitable, or broken in a way that makes the change unsalvageable as written.",
        },
      },
      required: ["summary", "findings", "verdict"],
      additionalProperties: false,
    },
  },
};

// The events the review endpoint streams.
//
// Declared here, and imported by BOTH the route that emits them and the component that
// renders them, so the two cannot drift. They already did once: the route moved the
// planner's cost into a totals object, the card went on reading plan.costUsd, and the
// page died on undefined.toFixed(). Nothing caught it, because a parsed JSON payload is
// `any` and an unchecked cast into a typed shape is a lie the compiler is happy to
// believe. A discriminated union makes an unhandled event a build error.
export type ReviewEvent =
  | { type: "plan"; plan: Plan & { overrides: Record<string, string>; costUsd: number } }
  | { type: "specialist_start"; specialist: Specialist }
  | {
      type: "specialist_done";
      specialist: Specialist;
      findings: Finding[];
      droppedLineRefs: number;
    }
  | { type: "specialist_error"; specialist: Specialist; error: string }
  | { type: "synthesis_delta"; text: string }
  | {
      type: "synthesis_done";
      findings: SynthesizedFinding[];
      verdict: Verdict;
      // True when no model merged these findings — the synthesizer failed and they were
      // stapled together deterministically instead. It is a fact about how much the review
      // is worth, so it travels with the review rather than living in a server log.
      degraded: boolean;
    }
  | { type: "done"; cost: ReviewCost; cache: CacheReport }
  | {
      type: "error";
      error: string;
      // Set only when the pipeline itself billed something before it had to give up —
      // a planner or synthesizer that exhausted its retries, or a synthesis abandoned
      // mid-flight when the client disconnected. Absent (rather than 0) is how the route's
      // generic catch-all — an error that reached it with no idea what, if anything, was
      // billed — is told to leave the running total exactly where it was, instead of
      // stamping over it with a number that looks precise but is not. See billedSoFar in
      // lib/pipeline/review.ts.
      costUsd?: number;
    };

export type ReviewCost = {
  planUsd: number;
  specialistsUsd: number;
  synthesisUsd: number;
  totalUsd: number;
};

export type CacheReport = {
  mode: string;
  model: string;
  prefixTokens: number;
  minCacheTokens: number;
  clearsFloor: boolean;
  cachedTokens: number;
  inputTokens: number;
  hitRate: number;
};

// The tool every specialist is forced to call. One schema for all four, so the
// synthesizer downstream receives one shape regardless of who produced it.
export const FINDINGS_TOOL = {
  type: "function" as const,
  function: {
    name: "report_findings",
    description:
      "Report what you found. An empty list is a valid and expected answer for code that is fine.",
    parameters: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: [...SEVERITIES],
                description:
                  "high: exploitable, or breaks in production. medium: a real defect with a bounded blast radius. low: worth fixing, harms nothing today.",
              },
              line: {
                type: "integer",
                description:
                  "The 1-indexed line number, taken from the numbering in the code you were given. Never guess: if you cannot point at a line, do not report the finding.",
              },
              issue: {
                type: "string",
                description:
                  "What is wrong, in one sentence. State the defect, not its category.",
              },
              suggestion: {
                type: "string",
                description:
                  "The concrete fix. Show the change, do not describe the direction of it.",
              },
            },
            required: ["severity", "line", "issue", "suggestion"],
            additionalProperties: false,
          },
        },
      },
      required: ["findings"],
      additionalProperties: false,
    },
  },
};

// The planner is a language model, so it can return a specialist that does not
// exist, capitalise one, or repeat it twice. Filter to the known set before
// anything downstream trusts it as a key.
//
// Whatever gets discarded is RETURNED, not swallowed. A silent filter here would
// be the nastiest bug in the pipeline: the planner says "security" with a capital
// S, the filter drops it, and the UI renders a confident, well-reasoned decision
// to skip Security — reasoning text and all — that the planner never actually made.
// A skip that is really a parse failure must not be able to impersonate a judgement
// call.
export function coerceSpecialists(value: unknown): {
  agents: Specialist[];
  dropped: unknown[];
} {
  if (!Array.isArray(value)) {
    return { agents: [], dropped: value === undefined ? [] : [value] };
  }

  const known = new Set<string>(SPECIALISTS);
  const agents = new Set<Specialist>();
  const dropped: unknown[] = [];

  for (const v of value) {
    if (typeof v === "string" && known.has(v)) agents.add(v as Specialist);
    else dropped.push(v);
  }

  return { agents: [...agents], dropped };
}
