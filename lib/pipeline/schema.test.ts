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

// The second constraint on the same ordering, and it was paid for in a red eval. With
// `verdict` declared last, behind the long nested `findings` array, the synthesizer
// sometimes closed its object without ever emitting the field — `required` is a strong
// hint to a model, not a guarantee. validVerdict then fails closed to changes_requested,
// which is right in isolation and wrong in aggregate: on code that is genuinely clean it
// turns a serialisation slip into a blocked merge, and the eval reports it as the reviewer
// hallucinating a defect it never actually claimed.
//
// Declaring it early costs the same thing the summary already costs — the model commits to
// a verdict before writing the findings that justify it — and that price is affordable for
// the same reason: synthesis re-ranks work it was handed rather than discovering anything.
test("verdict is declared before findings — a field emitted last is a field that gets dropped", () => {
  const keys = Object.keys(SYNTHESIS_TOOL.function.parameters.properties);
  assert.ok(
    keys.indexOf("verdict") < keys.indexOf("findings"),
    `verdict must precede findings, got: ${keys.join(", ")}`,
  );
});
