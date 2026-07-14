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

// The planner is a language model, so it can return a specialist that does not
// exist or repeat one twice. Filter to the known set before anything downstream
// trusts it as a key.
export function coerceSpecialists(value: unknown): Specialist[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(SPECIALISTS);
  return [
    ...new Set(
      value.filter((v): v is Specialist => typeof v === "string" && known.has(v)),
    ),
  ];
}
