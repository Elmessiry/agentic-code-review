import { callTool, type Usage } from "@/lib/openrouter";
import { plannerMessages } from "@/lib/prompts/planner";
import {
  coerceSpecialists,
  PLANNER_TOOL,
  SPECIALISTS,
  type Plan,
  type Specialist,
} from "./schema";
import { tripwires } from "./tripwire";

type PlannerArgs = {
  relevant_agents: unknown;
  reasoning: unknown;
};

// Decides which specialists run.
//
// Two inputs, and they are not equal partners. The planner is a language model
// making a judgement call about relevance; the tripwire is a regex that has already
// seen something alarming. Where they disagree, the tripwire wins — but only ever in
// the direction of running MORE specialists. Nothing in this function can remove a
// specialist the tripwire asked for.
export async function plan(
  code: string,
  signal?: AbortSignal,
): Promise<{ plan: Plan; usage: Usage }> {
  const forced = tripwires(code);

  const { args, usage } = await callTool<PlannerArgs>({
    role: "planner",
    messages: plannerMessages(code),
    tool: PLANNER_TOOL,
    signal,
  });

  const { agents: chosen, dropped } = coerceSpecialists(args.relevant_agents);

  if (dropped.length > 0) {
    // The planner emitted something outside the schema. The tool call constrains
    // relevant_agents with an enum, but that is a hint the model can miss — and the
    // planner deliberately runs on the weakest model in the registry, which is
    // exactly where a miss is likeliest. Log it loudly: a dropped value is the
    // difference between a deliberate skip and a parse failure wearing its clothes.
    console.warn(
      "[plan] planner returned specialists outside the schema",
      JSON.stringify({ dropped, kept: chosen }),
    );
  }

  const forcedNames = forced.map((f) => f.specialist);

  // The union, in a stable order. Sorting by SPECIALISTS rather than by whichever
  // list happened to mention them first keeps the pipeline graph from reshuffling
  // its nodes between runs.
  const agents = SPECIALISTS.filter((s) => chosen.includes(s) || forcedNames.includes(s));

  const reasoning =
    typeof args.reasoning === "string" && args.reasoning.trim().length > 0
      ? args.reasoning.trim()
      : "The planner gave no reasoning.";

  return {
    plan: {
      agents,
      skipped: SPECIALISTS.filter((s) => !agents.includes(s)),
      // Only report an override where the planner actually disagreed. A tripwire
      // that fires for Security on code the planner already routed to Security has
      // overruled nobody, and saying so would be noise.
      forced: forcedNames.filter((s: Specialist) => !chosen.includes(s)),
      reasoning,
    },
    usage,
  };
}

// The user-facing explanation of an override. Kept next to plan() because the
// wording is part of the argument the UI makes: the planner is auditable, and when
// it is overruled you can see exactly what overruled it.
export function overrideNotes(code: string): Record<string, string> {
  return Object.fromEntries(tripwires(code).map((f) => [f.specialist, f.because]));
}
