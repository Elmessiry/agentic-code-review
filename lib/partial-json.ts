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
  // The marker that means the provider has started leaking its own tool-call syntax INTO
  // the value. See the note on `out` below.
  private readonly stop: string;
  // Only used before the field is located: the object's head, where the key lives.
  private head = "";
  // Encoded characters that have arrived but cannot be decoded yet — at most a dangling
  // escape, waiting for the fragment that finishes it.
  private raw = "";
  // Everything decoded so far, which is needed to find a stop marker that straddles a
  // fragment boundary.
  //
  // The marker exists because of a real provider defect, caught by the eval suite rather
  // than by reasoning. The model writes its tool call in an XML-ish parameter format and
  // the provider serialises it to JSON badly, so a summary comes back ending:
  //
  //   ...nothing here breaks silently today.</summary>\n<parameter name="verdict">approve
  //
  // Everything after the field's own closing tag has been swallowed INTO the field, and
  // the fields that followed it never became JSON keys at all. The same model on the same
  // provider does it on roughly two runs in three, so it cannot be routed around and it
  // cannot be assumed away. The value is truncated at the tag: whatever comes after it is
  // the provider's mess, not the review, and the user must never see it.
  private out = "";
  // How much of `out` has already been handed to the caller.
  private emitted = 0;
  private started = false;
  private finished = false;

  constructor(field: string) {
    this.key = `"${field}"`;
    this.stop = `</${field}>`;
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
    this.out += text;

    // The provider has started leaking its tool-call syntax into the value. Everything
    // from the tag onward is not part of the field.
    const leak = this.out.indexOf(this.stop);
    if (leak !== -1) {
      this.out = this.out.slice(0, leak);
      this.finished = true;
    } else if (complete) {
      this.finished = true;
    }

    // While the value is still open, hold back the last few characters: a stop marker
    // split across two fragments would otherwise be half-emitted before it could be
    // recognised, and emitted text cannot be taken back. The lag is a handful of
    // characters and disappears the moment the field closes.
    const safeEnd = this.finished
      ? this.out.length
      : Math.max(0, this.out.length - (this.stop.length - 1));

    if (safeEnd <= this.emitted) return "";

    const fresh = this.out.slice(this.emitted, safeEnd);
    this.emitted = safeEnd;

    return fresh;
  }
}

// Recovers fields the provider swallowed, from the value it swallowed them into.
//
// Same defect as the stop marker above, seen from the other end: when the leak happens,
// the fields that came after the leaked one never become JSON keys, so `verdict` simply
// is not there. It has not vanished, though — it is sitting in the previous field's text,
// in the format the model actually wrote it in. Reading it back out is strictly better
// than discarding a verdict the model did produce and falling back to a default it did
// not choose.
export function recoverLeakedFields(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /<parameter name="([^"]+)">\s*([^<\n]*)/g;

  for (const [, name, value] of text.matchAll(pattern)) {
    const trimmed = value.trim();
    if (trimmed.length > 0) found[name] = trimmed;
  }

  return found;
}
