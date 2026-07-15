import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePipeline, type NodeState, type PipelineInput } from "./pipeline-stages";
import type { PlanResult } from "./plan-card";
import type { SpecialistNode } from "./findings-panel";

// The graph is only as honest as this derivation. Every stage state below is a claim the
// UI makes to someone watching a run — "the planner is working", "a specialist failed",
// "nobody was selected" — so each one is pinned to the state that should produce it.

const base: PipelineInput = {
  status: "idle",
  plan: null,
  nodes: [],
  summary: "",
  findings: null,
};

function plan(over: Partial<PlanResult> = {}): PlanResult {
  return {
    agents: ["security", "performance"],
    skipped: [],
    forced: [],
    reasoning: "",
    overrides: {},
    costUsd: 0,
    ...over,
  };
}

function stateOf(input: PipelineInput, id: string): NodeState {
  const stage = derivePipeline(input).find((s) => s.id === id);
  assert.ok(stage, `no stage ${id}`);
  return stage.state;
}

test("idle: every stage is pending", () => {
  for (const stage of derivePipeline(base)) {
    assert.equal(stage.state, "pending", stage.id);
  }
});

test("a guard rejection fails the guard and leaves the rest pending", () => {
  const input = { ...base, status: "error" as const };
  assert.equal(stateOf(input, "guard"), "failed");
  assert.equal(stateOf(input, "plan"), "pending");
  assert.equal(stateOf(input, "done"), "failed");
});

test("planning: guard done, tripwire waits, planner runs", () => {
  const input = { ...base, status: "running" as const };
  assert.equal(stateOf(input, "guard"), "done");
  assert.equal(stateOf(input, "tripwire"), "pending");
  assert.equal(stateOf(input, "plan"), "running");
  assert.equal(stateOf(input, "specialists"), "pending");
});

test("the plan event settles the tripwire and opens the fan", () => {
  const input = { ...base, status: "running" as const, plan: plan() };
  assert.equal(stateOf(input, "tripwire"), "done");
  assert.equal(stateOf(input, "plan"), "done");

  const fan = derivePipeline(input).find((s) => s.kind === "fan");
  assert.ok(fan && fan.kind === "fan");
  assert.deepEqual(
    fan.lanes.map((l) => l.state),
    ["pending", "pending"],
  );
});

test("lanes advance independently, and a forced lane is flagged", () => {
  const nodes: SpecialistNode[] = [
    { specialist: "security", status: "done", findings: [], droppedLineRefs: 0 },
    { specialist: "performance", status: "running" },
  ];
  const input = {
    ...base,
    status: "running" as const,
    plan: plan({ forced: ["security"] }),
    nodes,
  };

  const fan = derivePipeline(input).find((s) => s.kind === "fan");
  assert.ok(fan && fan.kind === "fan");
  assert.equal(fan.state, "running");
  assert.deepEqual(
    fan.lanes.map((l) => [l.specialist, l.state, l.forced]),
    [
      ["security", "done", true],
      ["performance", "running", false],
    ],
  );
});

test("a planner that selects nobody skips the fan, not fails it", () => {
  const input = { ...base, status: "running" as const, plan: plan({ agents: [] }) };
  assert.equal(stateOf(input, "specialists"), "skipped");
});

test("synthesis runs while the summary streams, done when findings land", () => {
  const running = {
    ...base,
    status: "running" as const,
    plan: plan(),
    nodes: [
      { specialist: "security", status: "done", findings: [], droppedLineRefs: 0 },
      { specialist: "performance", status: "done", findings: [], droppedLineRefs: 0 },
    ] as SpecialistNode[],
    summary: "The query is…",
  };
  assert.equal(stateOf(running, "specialists"), "done");
  assert.equal(stateOf(running, "synthesize"), "running");

  const settled = { ...running, findings: [], status: "done" as const };
  assert.equal(stateOf(settled, "synthesize"), "done");
  assert.equal(stateOf(settled, "done"), "done");
});

test("an error during synthesis fails synthesis and the finish", () => {
  const input = {
    ...base,
    status: "error" as const,
    plan: plan(),
    nodes: [
      { specialist: "security", status: "done", findings: [], droppedLineRefs: 0 },
      { specialist: "performance", status: "done", findings: [], droppedLineRefs: 0 },
    ] as SpecialistNode[],
    summary: "half a sen",
  };
  assert.equal(stateOf(input, "specialists"), "done");
  assert.equal(stateOf(input, "synthesize"), "failed");
  assert.equal(stateOf(input, "done"), "failed");
});

test("every selected specialist failing fails the fan", () => {
  const input = {
    ...base,
    status: "running" as const,
    plan: plan(),
    nodes: [
      { specialist: "security", status: "failed", error: "x" },
      { specialist: "performance", status: "failed", error: "y" },
    ] as SpecialistNode[],
  };
  assert.equal(stateOf(input, "specialists"), "failed");
});
