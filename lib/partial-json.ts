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
//   A fragment can end INSIDE an escape sequence. A naive slice emits a lone backslash,
//   or half of a \uXXXX, and the text is corrupt from that character on. So the tail is
//   held back until the next fragment completes it.
//
//   The field must be located exactly once. Re-scanning for `"summary"` on every
//   fragment means a later value that happens to contain that string could hijack the
//   decoder mid-stream. The opening quote is found once, and after that the decoder
//   never looks at the key again.
//
// Fragments are consumed once and dropped, rather than re-scanned from the top of an
// ever-growing buffer: the decoder is fed each fragment as it arrives, so the work is
// linear in the length of the field rather than quadratic in the number of chunks.

export class FieldDecoder {
  private readonly key: string;
  // Only used before the field is located: the object's head, where the key lives.
  private head = "";
  // Encoded characters that have arrived but cannot be decoded yet — at most a dangling
  // escape, waiting for the fragment that finishes it.
  private raw = "";
  private started = false;
  private finished = false;

  constructor(field: string) {
    this.key = `"${field}"`;
  }

  // Feed one fragment. Returns the characters it added to the field, decoded — or ""
  // when the fragment carried nothing safely decodable (it landed inside an escape), the
  // field has not appeared yet, or it is not a string.
  push(fragment: string): string {
    if (this.finished) return "";

    if (!this.started) {
      this.head += fragment;

      const at = this.head.indexOf(this.key);
      if (at === -1) return "";

      const colon = this.head.indexOf(":", at + this.key.length);
      if (colon === -1) return "";

      let i = colon + 1;
      while (i < this.head.length && /\s/.test(this.head[i])) i++;

      // The value has not started arriving yet — wait for the next fragment.
      if (i >= this.head.length) return "";

      // It is not a string at all: a null, a number, an array. Nothing to stream, and
      // nothing more to look for.
      if (this.head[i] !== '"') {
        this.finished = true;
        return "";
      }

      this.started = true;
      this.raw = this.head.slice(i + 1);
      this.head = "";
    } else {
      this.raw += fragment;
    }

    return this.drain();
  }

  // Decodes as much of `raw` as is safe, keeps the rest for the next fragment.
  private drain(): string {
    // The closing quote, if the value has finished. A quote preceded by a backslash is
    // escaped and ends nothing.
    let end = -1;
    for (let i = 0; i < this.raw.length; i++) {
      if (this.raw[i] === "\\") {
        i++;
        continue;
      }
      if (this.raw[i] === '"') {
        end = i;
        break;
      }
    }

    const complete = end !== -1;
    const encoded = complete ? this.raw.slice(0, end) : this.raw;

    // A truncated escape is at most six characters (\uXXXX), so that is how far back the
    // tail is worth trimming. Once the string has closed there is nothing dangling and
    // the whole thing must parse as it stands.
    const floor = complete ? encoded.length : Math.max(0, encoded.length - 6);

    let text: string | null = null;
    let cut = encoded.length;

    for (; cut >= floor; cut--) {
      try {
        text = JSON.parse(`"${encoded.slice(0, cut)}"`) as string;
        break;
      } catch {
        // Still ends inside an escape. Shorten and try again.
      }
    }

    // Nothing in this fragment can be decoded yet. Hold it all and wait.
    if (text === null) return "";

    this.raw = complete ? "" : encoded.slice(cut);
    if (complete) this.finished = true;

    return text;
  }
}
