// Reading one string field out of a JSON object that is still being written.
//
// This exists because of how a streamed tool call arrives. The model's structured
// output comes back as raw JSON fragments, split wherever the network split them —
// `{"summary": "The code buil` was a real chunk boundary from the live API. Waiting for
// the object to close before showing anything means the user watches a spinner for the
// entire synthesis; so instead the first field is decoded out of the half-written text
// and forwarded as it grows.
//
// Two things make it harder than a substring:
//
//   The buffer can end INSIDE an escape sequence. A naive slice emits a lone backslash,
//   or half of a \uXXXX, and the text is corrupt from that character on. So the tail is
//   trimmed until what remains is something JSON will actually parse.
//
//   The field must be located exactly once. Re-scanning for `"summary"` on every
//   fragment means a later value that happens to contain that string could hijack the
//   decoder mid-stream. The opening quote is found once and remembered.

export class FieldDecoder {
  private readonly key: string;
  private start: number | null = null;
  private emitted = 0;

  constructor(field: string) {
    this.key = `"${field}"`;
  }

  // Given the whole buffer so far, returns only the characters that are NEW since the
  // last call — or "" if the field has not grown, has not appeared yet, or is not a
  // string.
  advance(buffer: string): string {
    if (this.start === null) {
      const at = buffer.indexOf(this.key);
      if (at === -1) return "";

      const colon = buffer.indexOf(":", at + this.key.length);
      if (colon === -1) return "";

      let i = colon + 1;
      while (i < buffer.length && /\s/.test(buffer[i])) i++;

      // The value has not started yet, or it is not a string at all — a null, a number,
      // an array. Nothing here to stream.
      if (i >= buffer.length || buffer[i] !== '"') return "";

      this.start = i + 1;
    }

    const decoded = decodePartial(buffer.slice(this.start));
    if (decoded.length <= this.emitted) return "";

    const fresh = decoded.slice(this.emitted);
    this.emitted = decoded.length;
    return fresh;
  }
}

// Decodes the body of a JSON string that may be truncated anywhere, including mid-escape.
export function decodePartial(raw: string): string {
  // Find the closing quote, if the string has finished. A quote preceded by a backslash
  // is escaped and ends nothing.
  let end = raw.length;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\") {
      i++;
      continue;
    }
    if (raw[i] === '"') {
      end = i;
      break;
    }
  }

  const encoded = raw.slice(0, end);

  // \uXXXX is the longest escape, so a truncated one costs at most six characters. Trim
  // one at a time until JSON accepts what is left; if six is not enough, this fragment
  // has nothing safe in it and the next one will complete the sequence.
  const floor = Math.max(0, encoded.length - 6);
  for (let cut = encoded.length; cut >= floor; cut--) {
    try {
      return JSON.parse(`"${encoded.slice(0, cut)}"`) as string;
    } catch {
      // Still ends inside an escape. Shorten and try again.
    }
  }

  return "";
}
