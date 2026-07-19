import assert from "node:assert/strict";
import { test } from "node:test";
import { SYNTHESIS_TOOL } from "./schema";

// Property order in SYNTHESIS_TOOL is load-bearing (see AGENTS.md, "The synthesizer's
// `summary` must stay FIRST"): models emit properties in the order the schema declares
// them, and streamTool decodes the summary out of the still-arriving tool-call
// arguments. Move `summary` below `findings` and the review still works — nothing
// streams, and nobody notices until a user is staring at a spinner. Nothing else fails
// on a reorder, so this test is the tripwire.

test("summary is the FIRST property in the synthesis tool schema — streaming depends on it", () => {
  const properties = SYNTHESIS_TOOL.function.parameters.properties;
  assert.equal(Object.keys(properties)[0], "summary");
});
