"use client";

import { Fragment } from "react";
import {
  derivePipeline,
  type Lane,
  type NodeState,
  type PipelineInput,
  type Stage,
} from "./pipeline-stages";

// The pipeline as a spine: guard → tripwire → plan → specialists (parallel) → synthesize
// → done, lit up by the same events the review streams. It is a second view over the
// state review-panel already holds, so it adds no data and no requests — only the shape.
//
// The one moving part is the connector feeding whichever stage is running; everything else
// is static. A pipeline that animates everywhere reads as a loading screen, not a system.

const NODE: Record<NodeState, string> = {
  pending: "border-border bg-surface text-muted",
  running: "border-accent bg-accent/10 text-accent",
  done: "border-accent/50 bg-accent/15 text-ink",
  failed: "border-high/60 bg-high/10 text-high",
  skipped: "border-border border-dashed bg-transparent text-muted opacity-70",
};

const DOT: Record<NodeState, string> = {
  pending: "bg-muted/50",
  running: "bg-accent",
  done: "bg-accent",
  failed: "bg-high",
  skipped: "bg-muted/40",
};

function StateDot({ state }: { state: NodeState }) {
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${DOT[state]} ${
        state === "running" ? "animate-pulse" : ""
      }`}
    />
  );
}

function StageNode({ label, state }: { label: string; state: NodeState }) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap ${NODE[state]}`}
    >
      <StateDot state={state} />
      {label}
    </div>
  );
}

function LaneNode({ lane }: { lane: Lane }) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] whitespace-nowrap ${NODE[lane.state]}`}
    >
      <StateDot state={lane.state} />
      {lane.label}
      {lane.forced && (
        <span className="border-high/50 text-high rounded-sm border px-1 text-[9px] font-semibold tracking-wide uppercase">
          forced
        </span>
      )}
    </div>
  );
}

// The fork/merge. One selected specialist is a straight pass-through — no bracket, because
// there is no parallelism to draw. Two or more fan into stacked lanes joined by a rail on
// each side, which is the parallelism made literal.
function Fan({ stage }: { stage: Extract<Stage, { kind: "fan" }> }) {
  if (stage.state === "skipped" || stage.lanes.length === 0) {
    return <StageNode label={stage.label} state={stage.state} />;
  }

  if (stage.lanes.length === 1) {
    return <LaneNode lane={stage.lanes[0]} />;
  }

  return (
    <div className="relative flex flex-col gap-1.5 py-1">
      {/* The rails span the lane centres; the per-lane stubs meet them. */}
      <span className="bg-border absolute top-3 bottom-3 left-0 w-px" aria-hidden />
      <span className="bg-border absolute top-3 right-0 bottom-3 w-px" aria-hidden />
      {stage.lanes.map((lane) => (
        <div key={lane.specialist} className="flex items-center">
          <span className="bg-border h-px w-3" aria-hidden />
          <LaneNode lane={lane} />
          <span className="bg-border h-px w-3" aria-hidden />
        </div>
      ))}
    </div>
  );
}

function Connector({ active }: { active: boolean }) {
  return (
    <div
      className={`h-px w-6 shrink-0 ${active ? "pipeline-flow" : "bg-border"}`}
      aria-hidden
    />
  );
}

export default function PipelineGraph(input: PipelineInput) {
  const stages = derivePipeline(input);

  return (
    <div className="border-border bg-surface overflow-x-auto rounded-lg border p-4">
      <div className="flex min-w-max items-center gap-0">
        {stages.map((stage, i) => (
          <Fragment key={stage.id}>
            {i > 0 && <Connector active={stages[i].state === "running"} />}
            {stage.kind === "fan" ? (
              <Fan stage={stage} />
            ) : (
              <StageNode label={stage.label} state={stage.state} />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
