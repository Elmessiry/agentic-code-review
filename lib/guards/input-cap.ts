// Validates the request body before a single token is spent.
//
// Shared by every route that reaches a model. The cap is not a UX preference — every
// character here is multiplied by however many specialists end up running, so an
// unbounded paste is an unbounded bill. It is enforced before the model call, never
// after.

// ~20k characters is a long file and comfortably short of any model's context window.
export const MAX_CODE_CHARS = 20_000;

type Ok = { ok: true; code: string };
type Err = { ok: false; response: Response };

function reject(error: string, status: number): Err {
  return {
    ok: false,
    response: Response.json(
      { error },
      { status, headers: { "Cache-Control": "no-store" } },
    ),
  };
}

export async function readCode(request: Request): Promise<Ok | Err> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reject("Expected a JSON body.", 400);
  }

  const code = (body as { code?: unknown })?.code;

  if (typeof code !== "string" || code.trim().length === 0) {
    return reject("Paste some code to review.", 400);
  }

  if (code.length > MAX_CODE_CHARS) {
    return reject(
      `That snippet is ${code.length.toLocaleString()} characters. The limit is ${MAX_CODE_CHARS.toLocaleString()} — review a single file or function instead.`,
      413,
    );
  }

  return { ok: true, code };
}
