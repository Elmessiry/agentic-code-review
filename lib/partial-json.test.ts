import assert from "node:assert/strict";
import { test } from "node:test";
import { FieldDecoder, recoverLeakedFields } from "./partial-json";

// FieldDecoder decodes one string field out of a JSON object that arrives in
// fragments split wherever the network happened to split them — never wherever a
// character boundary would be convenient. Its contract: the concatenation of every
// onDelta output must equal the field's fully-parsed value, no matter where the
// fragments are cut, and the tool-call leak defect described in partial-json.ts must
// never reach the caller.

// Runs the decoder over `raw` split at `at`, and returns everything it emitted,
// concatenated. Mirrors exactly how streamTool() feeds a live stream: one push per
// fragment, output collected as it comes.
function decodeSplit(raw: string, field: string, at: number): string {
  const decoder = new FieldDecoder(field);
  return decoder.push(raw.slice(0, at)) + decoder.push(raw.slice(at));
}

test("every split point across a value with an escaped quote, a backslash, a unicode escape, and a newline decodes to what JSON.parse would produce", () => {
  // café written as a \u escape, so this exercises the unicode-escape decode path
  // rather than a literal multi-byte character in the wire text.
  const raw = String.raw`{"summary":"She said \"stop\" and typed C:\\Users\\caf\u00e9\nnext line.","verdict":"approve"}`;
  const expected = (JSON.parse(raw) as { summary: string }).summary;

  for (let at = 0; at <= raw.length; at++) {
    assert.equal(decodeSplit(raw, "summary", at), expected, `split at index ${at}`);
  }
});

test("the field's own key, split across the fragment boundary, still locks on once it fully arrives", () => {
  const decoder = new FieldDecoder("summary");

  assert.equal(decoder.push('{"sum'), "");
  assert.equal(decoder.push('mary": "hello world"}'), "hello world");
});

test('a decoy field whose entire value is the word "summary" does not hijack the decoder away from the real key', () => {
  const raw = '{"note": "summary", "summary": "the real value"}';
  const decoder = new FieldDecoder("summary");

  assert.equal(decoder.push(raw), "the real value");
});

test("a leaked tool-call tag split across fragments is held back in full: nothing from the tag onward is ever emitted", () => {
  const decoder = new FieldDecoder("summary");

  const first = decoder.push('{"summary": "Looks fine here.</sum');
  // The wire text escapes its newline (\n, two characters) same as any JSON string
  // would — an unescaped control character here would be invalid JSON in its own
  // right, which is a different failure to the one this test is pinning.
  const second = decoder.push(String.raw`mary>\n<parameter name="verdict">approve"}`);

  assert.equal(first, "Looks fine here.");
  assert.equal(second, "");

  // Finished — a further push (as if the stream kept going) still yields nothing.
  assert.equal(decoder.push("more text"), "");
});

test("a suspicious tail that turns out to be ordinary prose is released, untouched, once it stops matching the leak shape", () => {
  const decoder = new FieldDecoder("summary");

  // "</sum" is a prefix of the closing tag, so it is held back after the first push.
  const first = decoder.push('{"summary": "Check the closing tag: </sum');
  assert.equal(first, "Check the closing tag: ");

  // What follows is prose, not "<parameter" — so the whole tag plus the rest of the
  // sentence is released once the string closes.
  const second = decoder.push('mary> at the end of the doc."}');
  assert.equal(second, "</summary> at the end of the doc.");
});

test("a non-string field value (null) finishes the decoder silently, with nothing emitted", () => {
  const decoder = new FieldDecoder("summary");

  assert.equal(decoder.push('{"summary": nu'), "");
  // The field was never a string — further fragments, even ones that would have
  // completed a string, produce nothing.
  assert.equal(decoder.push('ll, "other": "x"}'), "");
});

test("recoverLeakedFields extracts every named parameter from a leaked tail and drops the ones with empty values", () => {
  const tail =
    '</summary>\n<parameter name="verdict">approve\n' +
    '<parameter name="note">   \n' +
    '<parameter name="reason">clear';

  assert.deepEqual(recoverLeakedFields(tail), {
    verdict: "approve",
    reason: "clear",
  });
});
