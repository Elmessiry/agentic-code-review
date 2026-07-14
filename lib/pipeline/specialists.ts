import { callTool, type ChatMessage, type Usage } from "@/lib/openrouter";
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

export type FanOut = {
  results: SpecialistResult[];
  failures: SpecialistFailure[];
  costUsd: number;
  cachedTokens: number;
  inputTokens: number;
};

function messagesFor(specialist: Specialist, code: string, explicitCache: boolean) {
  const messages: ChatMessage[] = [
    // The shared, cacheable prefix: rubric, then the code. Byte-identical across all
    // four specialists, which is the entire reason it is worth caching.
    { role: "system", content: sharedPrefix(code, explicitCache) },
    // The only part that differs. It comes AFTER the breakpoint — put it before, and
    // the prefix stops being common and nothing caches.
    { role: "user", content: SPECIALIST_INSTRUCTIONS[specialist] },
  ];
  return messages;
}

async function runOne(specialist: Specialist, code: string): Promise<SpecialistResult> {
  const explicitCache = modelFor("specialist").caching === "explicit";

  const { args, usage } = await callTool<{ findings: unknown }>({
    role: "specialist",
    messages: messagesFor(specialist, code, explicitCache),
    tool: FINDINGS_TOOL,
  });

  const { findings, dropped } = dropImpossibleLines(
    attribute(args.findings, specialist),
    code,
  );

  return { specialist, findings, usage, droppedLineRefs: dropped };
}

// Runs the selected specialists and returns whatever came back.
//
// allSettled, never all. `Promise.all` rejects the moment one promise does, which would
// throw away three completed reviews the user has already paid for because a fourth
// provider hiccuped. A specialist that fails is a specialist that failed — it is not an
// outage, and the review is still worth showing.
//
// The fan-out shape is a cost decision, and which shape is right depends on the vendor:
//
//   automatic caching (OpenAI, DeepSeek) — the cache write is free, so fire all four at
//   once. Cold, they cost the same as no caching; warm, they all read. There is no
//   downside and no reason to serialise anything.
//
//   explicit caching (Anthropic) — the cache write costs a 1.25x PREMIUM. Fire four at a
//   cold prefix and all four miss, all four write, and the review costs ~5x the prefix
//   instead of 4x. Caching has made it MORE expensive. So the first specialist goes
//   alone, writes the cache, and the other three then read it at ~0.1x: about 1.55x
//   total, at the cost of one extra sequential hop of latency.
//
// The honest summary is that caching does not have one right answer here. It has a right
// answer per vendor, and the shape of the code has to follow it.
export async function fanOut(specialists: Specialist[], code: string): Promise<FanOut> {
  if (specialists.length === 0) {
    return { results: [], failures: [], costUsd: 0, cachedTokens: 0, inputTokens: 0 };
  }

  const warmFirst =
    modelFor("specialist").caching === "explicit" && specialists.length > 1;

  const settled: PromiseSettledResult<SpecialistResult>[] = [];

  if (warmFirst) {
    const [first, ...rest] = specialists;
    settled.push(...(await Promise.allSettled([runOne(first, code)])));
    settled.push(...(await Promise.allSettled(rest.map((s) => runOne(s, code)))));
  } else {
    settled.push(...(await Promise.allSettled(specialists.map((s) => runOne(s, code)))));
  }

  const results: SpecialistResult[] = [];
  const failures: SpecialistFailure[] = [];

  // Both branches above push in the order of `specialists` — the warm path splits it
  // into [first, ...rest] but does not reorder it — so the index lines up either way.
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
      return;
    }

    console.error(`[specialists] ${specialists[i]} failed`, outcome.reason);
    failures.push({
      specialist: specialists[i],
      // The reason can quote the upstream body, which can quote the prompt, which is
      // the user's code. It goes to the log; the browser gets a bare fact.
      error: "This specialist could not be reached.",
    });
  });

  return {
    results,
    failures,
    costUsd: results.reduce((sum, r) => sum + r.usage.costUsd, 0),
    cachedTokens: results.reduce((sum, r) => sum + r.usage.cachedTokens, 0),
    inputTokens: results.reduce((sum, r) => sum + r.usage.inputTokens, 0),
  };
}
