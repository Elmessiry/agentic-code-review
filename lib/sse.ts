// Reading Server-Sent Events off a fetch body. Used on both ends of this project: the
// server reads them from OpenRouter, the browser reads them from the server.
//
// It lives in its own file, with no imports, for a reason that is not just tidiness.
// The alternative was to export this from lib/openrouter.ts, and importing that module
// into a client component would drag the OpenRouter client — the module that reads
// OPENROUTER_API_KEY — into the browser bundle. A shared helper is not worth a
// server-only module crossing into the client, and duplicating fifteen lines to avoid
// that would have left two parsers to fix the next time one of them was wrong.

// Yields each `data:` payload from an SSE body, parsed.
//
// Lines are assembled from the byte stream rather than read from it: a chunk boundary
// lands wherever the network puts it, halfway through a JSON object as happily as
// between two. Comment lines are skipped — OpenRouter sends a `: OPENROUTER PROCESSING`
// heartbeat to hold the connection open while a model thinks, and treating one of those
// as data would break the stream on every slow call.
export async function* sseEvents(res: Response): AsyncGenerator<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response had no body to stream");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line.length === 0 || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;

        try {
          yield JSON.parse(payload);
        } catch {
          // A `data:` line that is not JSON is not something a caller can act on, and
          // it is not worth failing a review over. Note it and keep reading.
          console.warn("[sse] unparseable payload", payload);
        }
      }
    }
  } finally {
    // Cancel, not just release. A caller that stops reading early — at [DONE], or
    // because the loop above threw on a mid-stream error payload — leaves an undrained
    // body behind, and releasing the lock alone does not tell the transport that nobody
    // is coming back for the rest. The connection is then held open while the retry
    // above opens a second one, so a run of transient failures accumulates sockets for
    // the life of the request. Cancelling discards the remainder and frees it.
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored or closed, in which case there is nothing to
      // cancel and nothing to report — this is cleanup, not a code path with an opinion.
    }
    reader.releaseLock();
  }
}
