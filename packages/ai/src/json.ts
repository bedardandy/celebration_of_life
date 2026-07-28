/**
 * Getting JSON back out of a language model.
 *
 * Models wrap JSON in prose, in code fences, in an apology, or in all three.
 * None of that is a reason to fail a grieving family's evening, so we salvage
 * what we can before deciding an answer is unusable. Everything here is pure
 * string work — no schema, no provider — so it is cheap to test exhaustively.
 */

/** Strip ```json … ``` (or bare ```) fences, keeping the largest fenced block. */
export function stripCodeFences(raw: string): string {
  const fence = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;
  let best: string | undefined;
  for (const match of raw.matchAll(fence)) {
    const body = match[1];
    if (body !== undefined && (best === undefined || body.length > best.length)) best = body;
  }
  return (best ?? raw).trim();
}

/**
 * The outermost balanced `{…}` (or `[…]`) in a string, ignoring braces that
 * live inside string literals. Returns undefined when there is nothing that
 * even looks like JSON.
 */
export function salvageJsonText(raw: string): string | undefined {
  const text = stripCodeFences(raw);
  const start = firstStructuralIndex(text);
  if (start === -1) return undefined;
  const open = text[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // Unbalanced: fall back to first-open .. last-close, which rescues the common
  // "model ran out of tokens mid-sentence after the JSON" case.
  const last = text.lastIndexOf(close);
  return last > start ? text.slice(start, last + 1) : undefined;
}

function firstStructuralIndex(text: string): number {
  const brace = text.indexOf('{');
  const bracket = text.indexOf('[');
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

export type JsonParseOutcome =
  { ok: true; value: unknown; salvaged: boolean } | { ok: false; error: string };

/**
 * Parse model output as JSON, trying the literal text first and the salvaged
 * span second. `salvaged` says whether we had to go digging, which is worth
 * knowing when a provider keeps needing rescue.
 */
export function parseJsonLoose(raw: string): JsonParseOutcome {
  const direct = tryParse(raw.trim());
  if (direct.ok) return { ok: true, value: direct.value, salvaged: false };

  const salvaged = salvageJsonText(raw);
  if (salvaged === undefined) {
    return { ok: false, error: 'no JSON object or array found in the response' };
  }
  const second = tryParse(salvaged);
  if (second.ok) return { ok: true, value: second.value, salvaged: true };
  return { ok: false, error: second.error };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.length === 0) return { ok: false, error: 'response was empty' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
