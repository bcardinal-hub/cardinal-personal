// Shared JSON extraction for the AI idea generators (trade ideas, options,
// day trading) — all ask Claude for ONLY a JSON array, but a web-search-
// enabled response can add trailing commentary or, if max_tokens is too
// low, get cut off mid-object. Scans from the first "[" and tracks brace
// depth (respecting strings/escapes) to find the exact end of that array.
//
// Critical: on truncation (ran out of text before depth returned to 0),
// this THROWS rather than returning "[]". A truncated response is not the
// same thing as the model legitimately finding nothing — silently treating
// them the same means a real scan failure looks identical to "nothing
// stood out today," which is actively misleading. Let the caller's
// try/catch turn a real failure into a real error the user can see and
// retry, instead of a false "found: 0."
export function extractFirstJsonArray(text) {
  const start = text.indexOf("[");
  if (start === -1) {
    throw new Error(`Model didn't return a JSON array — got: ${text.slice(0, 200)}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("The response was cut off before the JSON array closed (likely hit the token limit) — try again.");
}
