import {
  SPECIALIST_LABELS,
  type Specialist,
  type SynthesizedFinding,
} from "@/lib/pipeline/schema";
import type { PlanResult } from "./plan-card";
import type { SpecialistNode } from "./findings-panel";

// Turning the review page's live state into the pipeline graph's node states.
//
// This is pure on purpose: the graph is a second view over state review-panel already
// holds, and the interesting part — what each stage's state IS at a given moment — is
// logic, not layout. Keeping it here means it can be tested without a browser, and the
// component that draws it stays a dumb mapping from state to colour.
//
// The honest-signal problem it solves: the client does not see every stage run. The guard
// runs before the stream opens, and the tripwire's result rides in on the `plan` event, so
// neither is ever observed "running". The derivation says so rather than inventing motion.

export type NodeState = "pending" | "running" | "done" | "failed" | "skipped";
export type LaneState = "pending" | "running" | "done" | "failed";
export type StageId =
  "guard" | "tripwire" | "plan" | "specialists" | "synthesize" | "done";

export type Lane = {
  specialist: Specialist;
  label: string;
  state: LaneState;
  // The tripwire compelled this specialist even though the planner skipped it. Worth a
  // badge: it is the deterministic net overruling a language model, which is the whole
  // reason the tripwire exists.
  forced: boolean;
};

export type Stage =
  | { kind: "node"; id: StageId; label: string; state: NodeState }
  | { kind: "fan"; id: "specialists"; label: string; state: NodeState; lanes: Lane[] };

export type PipelineInput = {
  status: "idle" | "running" | "done" | "error";
  plan: PlanResult | null;
  nodes: SpecialistNode[];
  summary: string;
  findings: SynthesizedFinding[] | null;
};

const isTerminal = (s: LaneState): boolean => s === "done" || s === "failed";

export function derivePipeline(input: PipelineInput): Stage[] {
  const { status, plan, nodes, summary, findings } = input;

  const started = status !== "idle";
  const errored = status === "error";
  const finished = status === "done";
  const planned = plan !== null;

  // Any streamed artefact — or a clean finish — proves the guard passed and the stream
  // opened. An error with none of them is the guard (or the connection) failing before a
  // single event arrived: the one failure the client never sees from inside the stream.
  const streamed = planned || nodes.length > 0 || summary.length > 0 || finished;
  const guardFailed = errored && !streamed;

  const lanes = deriveLanes(plan, nodes, errored);
  const fan = fanState(planned, plan?.agents.length ?? 0, lanes);
  const fanSettled = fan === "done" || fan === "failed" || fan === "skipped";

  return [
    {
      kind: "node",
      id: "guard",
      label: "Guard",
      state: guardState(started, guardFailed),
    },
    {
      kind: "node",
      id: "tripwire",
      label: "Tripwire",
      state: tripwireState(started, guardFailed, planned),
    },
    {
      kind: "node",
      id: "plan",
      label: "Plan",
      state: planState(started, guardFailed, planned, errored, streamed),
    },
    { kind: "fan", id: "specialists", label: "Specialists", state: fan, lanes },
    {
      kind: "node",
      id: "synthesize",
      label: "Synthesize",
      state: synthState(planned, summary, findings, errored, fanSettled),
    },
    {
      kind: "node",
      id: "done",
      label: "Done",
      state: finished ? "done" : errored ? "failed" : "pending",
    },
  ];
}

// One lane per specialist the planner selected, carrying its live status. A run that died
// mid-fan leaves no specialist half-lit: an unfinished lane reads as failed, not as still
// working.
//
// But only once the fan was actually reached. An error before any specialist started — the
// plan lands, then the budget timer aborts the stream — never ran these lanes, so failing
// them would blame work that never happened. `nodes.length > 0` is the proof the fan was in
// flight: at least one specialist_start arrived. Before that, an unfinished lane is pending,
// and the failure belongs to the stage upstream that the Done node already marks failed.
function deriveLanes(
  plan: PlanResult | null,
  nodes: SpecialistNode[],
  errored: boolean,
): Lane[] {
  if (!plan) return [];

  const fanReached = nodes.length > 0;

  return plan.agents.map((specialist) => {
    const node = nodes.find((n) => n.specialist === specialist);
    let state: LaneState = node ? node.status : "pending";
    if (errored && fanReached && !isTerminal(state)) state = "failed";

    return {
      specialist,
      label: SPECIALIST_LABELS[specialist],
      state,
      forced: plan.forced.includes(specialist),
    };
  });
}

function guardState(started: boolean, guardFailed: boolean): NodeState {
  if (!started) return "pending";
  return guardFailed ? "failed" : "done";
}

// The tripwire never shows "running": its result arrives on the plan event, so it is
// pending until the plan lands and done the moment it does.
function tripwireState(
  started: boolean,
  guardFailed: boolean,
  planned: boolean,
): NodeState {
  if (!started || guardFailed) return "pending";
  return planned ? "done" : "pending";
}

function planState(
  started: boolean,
  guardFailed: boolean,
  planned: boolean,
  errored: boolean,
  streamed: boolean,
): NodeState {
  if (!started || guardFailed) return "pending";
  if (planned) return "done";
  // The stream opened, then died before the plan arrived — planning is what failed.
  if (errored && streamed) return "failed";
  return "running";
}

function fanState(planned: boolean, selected: number, lanes: Lane[]): NodeState {
  if (!planned) return "pending";
  // The planner judged no lens worth running. Not a failure — a deliberate skip.
  if (selected === 0) return "skipped";
  if (lanes.every((l) => isTerminal(l.state))) {
    return lanes.every((l) => l.state === "failed") ? "failed" : "done";
  }
  if (lanes.some((l) => l.state === "running" || l.state === "done")) return "running";
  return "pending";
}

function synthState(
  planned: boolean,
  summary: string,
  findings: SynthesizedFinding[] | null,
  errored: boolean,
  fanSettled: boolean,
): NodeState {
  if (!planned) return "pending";
  if (findings !== null) return "done";
  if (!errored && summary.length > 0) return "running";
  // Reached synthesis and then the run died. Before the fan settled, synthesis was never
  // in flight, so pending is the honest state.
  if (errored && fanSettled) return "failed";
  return "pending";
}
