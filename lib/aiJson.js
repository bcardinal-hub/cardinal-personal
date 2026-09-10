// Shared JSON extraction for every place a Claude response is asked to be
// "ONLY a JSON object/array" — the 7 desk agents and market snapshot
// (object), and the 3 idea generators (array). A web-search-enabled
// response can add trailing commentary, get cut off mid-object if
// max_tokens is too low, or — the case this file specifically guards
// against — contain a literal raw newline/tab inside a string value
// instead of an escaped \n/\t, which JSON.parse rejects outright even
// though the surrounding structure is otherwise perfectly valid.
//
// Scans from the first opening bracket and tracks bracket depth (respecting
// strings/escapes) to find the exact end of that object/array, sanitizing
// any raw control character found *inside* a string literal along the way
// — never outside one, so the JSON's own structural characters are
// untouched.
//
// Critical: on truncation (ran out of text before depth returned to 0),
// this THROWS rather than returning "{}"/"[]". A truncated response is not
// the same thing as the model legitimately returning nothing — silently
// treating them the same means a real scan failure looks identical to
// "nothing stood out today," which is actively misleading. Let the
// caller's try/catch turn a real failure into a real error the user can
// see and retry, instead of a false empty result.
function extractBalanced(rawText, openChar, closeChar, kind) {
  const start = rawText.indexOf(openChar);
  if (start === -1) {
    throw new Error(`Model didn't return a JSON ${kind} — got: ${rawText.slice(0, 200)}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let out = "";
  for (let i = start; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        // Raw control character inside a string — escape the common ones,
        // drop anything more exotic rather than guess at intent.
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    out += ch;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return out;
    }
  }
  throw new Error(`The response was cut off before the JSON ${kind} closed (likely hit the token limit) — try again.`);
}

export function extractFirstJsonArray(text) {
  return extractBalanced(text, "[", "]", "array");
}

export function extractFirstJsonObject(text) {
  return extractBalanced(text, "{", "}", "object");
}
