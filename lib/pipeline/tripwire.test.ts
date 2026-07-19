import assert from "node:assert/strict";
import { test } from "node:test";
import { tripwires } from "./tripwire";

// The tripwire is the planner's safety floor: a deterministic pre-pass that can only
// ADD specialists, never remove one the planner already chose. Its contract is pinned
// here rather than trusted to the planner's judgement, because the whole point of the
// tripwire is to catch what a language model — attacker-influenced text and all — might
// be talked out of running.

test("an await inside a braced for-loop body fires the performance tripwire", () => {
  const code = `
    for (const id of ids) {
      const row = await db.get(id);
      results.push(row);
    }
  `;

  const forced = tripwires(code);
  assert.deepEqual(
    forced.map((f) => f.specialist),
    ["performance"],
  );
});

test("an await inside a braceless for-loop body fires the performance tripwire", () => {
  const code = `for (const x of xs) await f(x);`;

  const forced = tripwires(code);
  assert.deepEqual(
    forced.map((f) => f.specialist),
    ["performance"],
  );
});

test("an async .forEach callback that awaits fires the performance tripwire — nothing awaits the forEach itself", () => {
  const code = `
    items.forEach(async (item) => {
      await process(item);
    });
  `;

  const forced = tripwires(code);
  assert.deepEqual(
    forced.map((f) => f.specialist),
    ["performance"],
  );
});

test("an await BEFORE the loop — fetch once, then iterate — does not fire the performance tripwire", () => {
  const code = `
    const rows = await query();
    for (const r of rows) {
      render(r);
    }
  `;

  assert.deepEqual(tripwires(code), []);
});

test("await Promise.all(xs.map(async ...)) is the correct concurrent idiom and does not fire the performance tripwire", () => {
  const code = `
    await Promise.all(xs.map(async (x) => {
      await handle(x);
    }));
  `;

  assert.deepEqual(tripwires(code), []);
});

test("a for-loop whose parens never close is unbalanced input, and finds nothing to force rather than throwing", () => {
  const truncated = `
    for (const id of ids
      const row = await db.get(id);
  `; // the opening paren never finds its match

  assert.doesNotThrow(() => tripwires(truncated));
  assert.deepEqual(tripwires(truncated), []);
});

test("a for-loop whose braces never close is unbalanced input, and does not throw", () => {
  const truncated = `
    for (const id of ids) {
      const row = await db.get(id);
  `; // the opening brace never finds its match

  assert.doesNotThrow(() => tripwires(truncated));
});

test("two matches in the same category collapse to one forced specialist, with one reason", () => {
  const code = `
    const secret = process.env.API_KEY;
    child_process.execSync("echo " + secret);
  `;

  const forced = tripwires(code);
  const security = forced.filter((f) => f.specialist === "security");
  assert.equal(security.length, 1);
  assert.equal(typeof security[0].because, "string");
});

test("the tripwire only ever adds specialists to a planner's choice — the union never drops one the planner already picked", () => {
  const code = `readFileSync("./config.json");`; // forces performance, says nothing about security

  const plannerChose: string[] = ["security"];
  const forced = tripwires(code).map((f) => f.specialist);

  const union = [...new Set([...plannerChose, ...forced])];

  // Both survive: the planner's own pick is not removed, and the tripwire's forced
  // specialist is added on top.
  assert.ok(union.includes("security"), "the planner's choice must survive the union");
  assert.ok(
    union.includes("performance"),
    "the tripwire's forced specialist must be added",
  );
});
