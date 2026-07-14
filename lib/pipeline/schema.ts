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

export type Severity = "high" | "medium" | "low";

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

// What the review endpoint sends back.
//
// Declared here, and imported by BOTH the route and the component that renders it, so
// the two cannot drift. They already did once: the route moved the planner's cost into
// a totals object, the card went on reading plan.costUsd, and the page died on
// undefined.toFixed(). Nothing caught it, because `await res.json()` is `any` and an
// unchecked cast into a typed shape is a lie the compiler is happy to believe.
//
// The route annotates its payload with this type, so a field the UI needs and the
// server stopped sending is now a build error rather than a white screen.
export type ReviewResponse = {
  plan: Plan & {
    overrides: Record<string, string>;
    costUsd: number;
  };
  results: {
    specialist: Specialist;
    findings: Finding[];
    droppedLineRefs: number;
  }[];
  failures: { specialist: Specialist; error: string }[];
  cost: {
    planUsd: number;
    specialistsUsd: number;
    totalUsd: number;
  };
  cache: {
    mode: string;
    model: string;
    prefixTokens: number;
    minCacheTokens: number;
    clearsFloor: boolean;
    cachedTokens: number;
    inputTokens: number;
    hitRate: number;
  };
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
                enum: ["high", "medium", "low"],
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
