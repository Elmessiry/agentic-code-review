import assert from "node:assert/strict";
import { test } from "node:test";
import { sseEvents } from "./sse";

// The SSE parser's contract, pinned with chunk boundaries placed exactly where the
// network is least kind: mid-line, mid-JSON, and mid-UTF-8-sequence. Both ends of the
// project read streams through this one parser, so a boundary bug here corrupts the
// review on the way in AND on the way out.

const encoder = new TextEncoder();

// A Response whose body arrives in exactly these chunks, in exactly this order.
function sseResponse(chunks: (string | Uint8Array)[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
        controller.close();
      },
    }),
  );
}

async function collect(res: Response): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of sseEvents(res)) events.push(event);
  return events;
}

test("a data: line split across two reads reassembles into one event", async () => {
  const events = await collect(
    sseResponse(['data: {"summ', 'ary": "the chunk boundary landed mid-key"}\n']),
  );

  assert.deepEqual(events, [{ summary: "the chunk boundary landed mid-key" }]);
});

test("comment lines — the OPENROUTER PROCESSING heartbeat — are skipped, not parsed", async () => {
  const events = await collect(
    sseResponse([
      ": OPENROUTER PROCESSING\n",
      "\n",
      ": OPENROUTER PROCESSING\n",
      'data: {"ok": true}\n',
    ]),
  );

  assert.deepEqual(events, [{ ok: true }]);
});

test("[DONE] terminates the stream; anything after it is never yielded", async () => {
  const events = await collect(
    sseResponse(['data: {"first": 1}\n', "data: [DONE]\n", 'data: {"after": 2}\n']),
  );

  assert.deepEqual(events, [{ first: 1 }]);
});

test("an unparseable payload is skipped, not thrown — the stream keeps going", async (t) => {
  // The parser warns about the line it drops; keep the test output clean.
  const warn = t.mock.method(console, "warn", () => {});

  const events = await collect(
    sseResponse(["data: this is not JSON\n", 'data: {"still": "alive"}\n']),
  );

  assert.deepEqual(events, [{ still: "alive" }]);
  assert.equal(warn.mock.callCount(), 1);
});

test("a consumer that breaks early cancels the underlying reader, not just the lock", async () => {
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"first": true}\n'));
      // Deliberately never closed: an undrained connection is exactly what a
      // release-without-cancel would leave holding a socket open.
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const event of sseEvents(new Response(body))) {
    assert.deepEqual(event, { first: true });
    break;
  }

  assert.equal(cancelled, true, "breaking out of the loop must cancel the transport");
});

test("a multi-byte UTF-8 character split across a chunk boundary decodes intact", async () => {
  const bytes = encoder.encode('data: {"text": "🚀 déjà vu"}\n');

  // Split inside the rocket's four-byte sequence (F0 9F 9A 80): the first chunk ends
  // after its lead byte, the second begins mid-character.
  const split = bytes.indexOf(0x9f);
  assert.ok(split > 0, "the fixture should contain the emoji's continuation byte");

  const events = await collect(sseResponse([bytes.slice(0, split), bytes.slice(split)]));

  assert.deepEqual(events, [{ text: "🚀 déjà vu" }]);
});
