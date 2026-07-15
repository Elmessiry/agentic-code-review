// The model registry: which model does which job, what it costs, and — the part
// that actually shapes the code — how it caches.
//
// Every vendor difference in this project is quarantined in this file. The
// pipeline itself never names a model or a vendor; it asks for a role.

export type Role = "planner" | "specialist" | "synthesizer";

// How a vendor lets you reuse a repeated prompt prefix. This is not a pricing
// detail — it changes the orchestration (see FanOut in lib/pipeline).
//
//   explicit  — you mark the prefix with cache_control. Anthropic. The write is
//               charged at a PREMIUM (1.25x), so firing N specialists at a cold
//               prefix costs MORE than not caching at all.
//   automatic — the vendor caches prefixes for you and charges nothing to write.
//               OpenAI, DeepSeek, GLM, Kimi. Cold parallel fan-out is free of
//               penalty, so there is no reason not to fan out.
//   none      — no prefix caching. Pay full price every call.
export type Caching = "explicit" | "automatic" | "none";

// USD per one million tokens, as quoted by OpenRouter's /api/v1/models.
type Price = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelSpec = {
  id: string;
  caching: Caching;
  price: Price;
  // A cache breakpoint below this many tokens is silently ignored by the vendor.
  // The number is why this project caches the shared review context (taxonomy +
  // rubric + examples + the code itself) instead of the per-specialist system
  // prompts: those are ~500 tokens and would never have cached at all.
  minCacheTokens: number;
};

// Verified live against OpenRouter's model list, 2026-07-14. Model ids and
// prices drift — re-check before trusting these, and never add one here without
// confirming it reports `tools` and `structured_outputs` in supported_parameters.
export const MODELS = {
  "openai/gpt-5-nano": {
    id: "openai/gpt-5-nano",
    caching: "automatic",
    price: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
    minCacheTokens: 1024,
  },
  "openai/gpt-5-mini": {
    id: "openai/gpt-5-mini",
    caching: "automatic",
    price: { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0 },
    minCacheTokens: 1024,
  },
  "deepseek/deepseek-v4-pro": {
    id: "deepseek/deepseek-v4-pro",
    caching: "automatic",
    price: { input: 0.43, output: 0.87, cacheRead: 0.004, cacheWrite: 0 },
    minCacheTokens: 1024,
  },
  "z-ai/glm-4.7": {
    id: "z-ai/glm-4.7",
    caching: "automatic",
    price: { input: 0.4, output: 1.75, cacheRead: 0.08, cacheWrite: 0 },
    minCacheTokens: 1024,
  },
  "x-ai/grok-4.3": {
    id: "x-ai/grok-4.3",
    caching: "automatic",
    price: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    minCacheTokens: 1024,
  },
  "anthropic/claude-haiku-4.5": {
    id: "anthropic/claude-haiku-4.5",
    caching: "explicit",
    price: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    // Note the floor: 4096, not 1024. Haiku is the least cacheable model here.
    minCacheTokens: 4096,
  },
  "anthropic/claude-sonnet-5": {
    id: "anthropic/claude-sonnet-5",
    caching: "explicit",
    price: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
    minCacheTokens: 1024,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;

// Starting defaults. Deliberately mixed-vendor from day one: if the pipeline only
// ever ran Anthropic, the caching abstraction above would be untested theatre.
//
// These are a starting point, not a conclusion. The eval harness scores the
// candidates on recall, false positives, schema conformance, latency and real
// cost, and whatever it picks replaces these.
const DEFAULTS: Record<Role, ModelId> = {
  // Routing is classification, not reasoning. The cheapest model that can hold a
  // schema wins, and it is ~20x cheaper than the obvious Haiku answer.
  planner: "openai/gpt-5-nano",
  specialist: "openai/gpt-5-mini",
  // The hardest job: reconcile contradictory findings and write prose a human will
  // read. The matrix chose this, and did not choose the cheapest. Every candidate
  // tied on recall, false positives and conformance, so cost looked decisive — until
  // the clean case, run repeatedly, exposed a flake the averages hid: on genuinely
  // fine code, gpt-5-mini approved 1 run in 5 and grok-4.3 4 in 5, both blocking a
  // merge over low-severity notes, where Sonnet approved every time. The clean
  // anti-hallucination verdict is the case that matters most, so the model that holds
  // it wins even at 2x the price. See the matrix table in the README.
  synthesizer: "anthropic/claude-sonnet-5",
};

export const ENV_OVERRIDE: Record<Role, string> = {
  planner: "OPENROUTER_MODEL_PLANNER",
  specialist: "OPENROUTER_MODEL_SPECIALIST",
  synthesizer: "OPENROUTER_MODEL_SYNTHESIZER",
};

// The models the eval matrix scores for each role. This list lives here, not in the
// harness, for the same reason as everything else in this file: the harness is not
// allowed to name a model. It sweeps roles and ids abstractly, and the ids it is handed
// come from here.
//
// Every entry MUST be a key of MODELS — modelFor throws on an unknown override, and that
// is deliberate: it makes the matrix scoring the default under a typo impossible. The
// first id in each list is the current default, so the table always shows the incumbent
// next to its challengers.
//
// One role varies at a time; the other two are held constant at whatever they already
// resolve to (a default, or an env override if one is set). That isolates the candidate's
// effect — a specialist sweep where the synthesizer also changed would score two variables
// and attribute the difference to one.
export const CANDIDATES: Record<Role, ModelId[]> = {
  // Routing is classification. The question is whether the cheapest model that can hold a
  // schema routes as well as the ones that cost 20x — Haiku is here as the spec's original
  // answer, to be measured rather than assumed.
  planner: ["openai/gpt-5-nano", "openai/gpt-5-mini", "anthropic/claude-haiku-4.5"],
  // Real code reasoning under a forced schema, run 2-4x per review, so price matters most
  // here. deepseek-v4-pro is the interesting one: near-free cache reads.
  specialist: [
    "openai/gpt-5-mini",
    "deepseek/deepseek-v4-pro",
    "z-ai/glm-4.7",
    "anthropic/claude-sonnet-5",
  ],
  // The hardest job and the most expensive call in the pipeline. grok-4.3 has unusually
  // cheap output for a prose-heavy task; the question is whether it holds the schema.
  synthesizer: [
    "anthropic/claude-sonnet-5",
    "x-ai/grok-4.3",
    "openai/gpt-5-mini",
    "deepseek/deepseek-v4-pro",
  ],
};

// Resolves the model for a role, letting an env var override the default. The
// override is what lets the eval harness sweep a matrix of models without
// touching this file.
export function modelFor(role: Role): ModelSpec {
  const override = process.env[ENV_OVERRIDE[role]];
  if (!override) return MODELS[DEFAULTS[role]];

  const spec = MODELS[override as ModelId];
  if (!spec) {
    // Fail loud. A typo'd override that silently fell back to the default would
    // quietly invalidate every number the eval harness reports.
    throw new Error(
      `${ENV_OVERRIDE[role]}="${override}" is not a known model. ` +
        `Add it to MODELS in lib/models.ts (and confirm it supports tools + structured outputs).`,
    );
  }
  return spec;
}

// What a call actually cost, in dollars. OpenRouter reports this directly on the
// response, so we never estimate from token counts — the spend cap counts real
// money. This helper exists only for the eval harness, which needs to price a
// hypothetical model without running it.
export function estimateCost(
  spec: ModelSpec,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number {
  const perM = (n: number, rate: number) => (n / 1_000_000) * rate;
  return (
    perM(tokens.input, spec.price.input) +
    perM(tokens.output, spec.price.output) +
    perM(tokens.cacheRead ?? 0, spec.price.cacheRead) +
    perM(tokens.cacheWrite ?? 0, spec.price.cacheWrite)
  );
}
