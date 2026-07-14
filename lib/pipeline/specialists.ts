import {
  callTool,
  OpenRouterError,
  type ChatMessage,
  type Usage,
} from "@/lib/openrouter";
import { modelFor } from "@/lib/models";
import { sharedPrefix } from "@/lib/prompts/shared-prefix";
import { SPECIALIST_INSTRUCTIONS } from "@/lib/prompts/specialists";
import { FINDINGS_TOOL, type Finding, type Specialist } from "./schema";
import { attribute, dropImpossibleLines } from "./line-refs";

export type SpecialistResult = {
  specialist: Specialist;
  findings: Finding[];
  usage: Usage;
  droppedLineRefs: number;
};

export type SpecialistFailure = {
  specialist: Specialist;
  error: string;
};

// Every specialist run resolves to one of these — runOne never rejects. The
// specialist's identity travels INSIDE the outcome, so nothing downstream ever has
// to reconstruct who failed from array positions. An earlier version attributed
// failures via index alignment between two arrays, guarded by a comment; a comment
// is not a type, and misattributing a failure card to the wrong specialist is
// exactly the kind of bug that survives every test that only exercises success.
type SpecialistOutcome =
  | { ok: true; result: SpecialistResult }
  | { ok: false; failure: SpecialistFailure; usage: Usage };

export type FanOut = {
  results: SpecialistResult[];
  failures: SpecialistFailure[];
  costUsd: number;
  cachedTokens: number;
  inputTokens: number;
};

function messagesFor(
  specialist: Specialist,
  code: string,
  explicitCache: boolean,
): ChatMessage[] {
  return [
    // The shared, cacheable prefix: rubric, then the code. Byte-identical across all
    // four specialists, which is the entire reason it is worth caching.
    { role: "system", content: sharedPrefix(code, explicitCache) },
    // The only part that differs. It comes AFTER the breakpoint — put it before, and
    // the prefix stops being common and nothing caches.
    { role: "user", content: SPECIALIST_INSTRUCTIONS[specialist] },
  ];
}

// Total by construction: failures are caught here, where the specialist's name is in
// scope, and returned as data. The usage on a failure is whatever the attempts were
// billed before giving up — a specialist that died after two paid retries still spent
// real money, and the totals below have to be able to count it.
async function runOne(
  specialist: Specialist,
  code: string,
  explicitCache: boolean,
): Promise<SpecialistOutcome> {
  try {
    const { args, usage } = await callTool<{ findings: unknown }>({
      role: "specialist",
      messages: messagesFor(specialist, code, explicitCache),
      tool: FINDINGS_TOOL,
    });

    const { findings, dropped } = dropImpossibleLines(
      attribute(args.findings, specialist),
      code,
    );

    return {
      ok: true,
      result: { specialist, findings, usage, droppedLineRefs: dropped },
    };
  } catch (error) {
    console.error(`[specialists] ${specialist} failed`, error);
    return {
      ok: false,
      failure: {
        specialist,
        // The underlying error can quote the upstream body, which can quote the
        // prompt, which is the user's code. It went to the log; the browser gets
        // a bare fact.
        error: "This specialist could not be reached.",
      },
      usage: error instanceof OpenRouterError ? error.usage : zeroUsage(),
    };
  }
}

function zeroUsage(): Usage {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

// Runs the selected specialists and returns whatever came back — results, failures,
// and what ALL of it cost, including the attempts that died.
//
// The fan-out shape is a cost decision, and the right shape depends on the model's
// caching mode (lib/models.ts):
//
//   automatic — the cache write is free, so fire everything at once. Cold, the calls
//   cost what no caching costs; warm, they all read. No downside to parallelism.
//
//   explicit — the cache write costs a premium (1.25x on the models measured). Fire
//   four at a cold prefix and all four miss, all four write, and the review costs ~5x
//   the prefix instead of 4x: caching has made it MORE expensive. So one specialist
//   goes first to write the cache, and the rest fan out as readers at ~0.1x.
//
// The warm step must actually SUCCEED before the fan-out happens. If the warmer dies
// and the rest launch anyway, they hit a cold prefix in parallel and pay the write
// premium three times over — the exact scenario the sequencing exists to avoid. So on
// a failed warm the next specialist takes over as the warmer, and the parallel group
// only launches once somebody has written the cache (or nobody is left to).
//
// Parallelism is Promise.all, and that is safe here for a structural reason: runOne
// cannot reject, so there is no rejection for Promise.all to propagate. The old rule
// of thumb — allSettled, never all — existed to stop one dead specialist taking down
// a review the user already paid for; that guarantee now lives one level down, inside
// runOne, where the failure can be attributed by name instead of by array position.
export async function fanOut(specialists: Specialist[], code: string): Promise<FanOut> {
  const outcomes: SpecialistOutcome[] = [];

  if (specialists.length > 0) {
    // Derived once. runOne and the warm decision below must agree on the caching
    // mode, and two independent reads of modelFor() are two places to update when a
    // caching mode is added — the kind of pair that drifts.
    const explicitCache = modelFor("specialist").caching === "explicit";

    let remaining = [...specialists];

    if (explicitCache) {
      while (remaining.length > 1) {
        const [warmer, ...rest] = remaining;
        const outcome = await runOne(warmer, code, explicitCache);
        outcomes.push(outcome);
        remaining = rest;
        if (outcome.ok) break;
      }
    }

    outcomes.push(
      ...(await Promise.all(remaining.map((s) => runOne(s, code, explicitCache)))),
    );
  }

  const results = outcomes.filter((o) => o.ok).map((o) => o.result);
  const failures = outcomes.filter((o) => !o.ok).map((o) => o.failure);

  // Totals over every outcome, not just the survivors. A failed specialist's billed
  // attempts are still spend, and the number shown to the user is only honest if it
  // includes them.
  const usages = outcomes.map((o) => (o.ok ? o.result.usage : o.usage));

  return {
    results,
    failures,
    costUsd: usages.reduce((sum, u) => sum + u.costUsd, 0),
    cachedTokens: usages.reduce((sum, u) => sum + u.cachedTokens, 0),
    inputTokens: usages.reduce((sum, u) => sum + u.inputTokens, 0),
  };
}
