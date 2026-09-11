// One shared path for every "ask Claude for structured JSON" call the idea
// generators make. Previously this exact fetch/parse/strip logic was
// copy-pasted in three files, which meant each bug found (truncation,
// citation-tag leakage, raw control characters) had to be fixed three
// times and the third copy was always the one that got missed.
//
// It also handles the failure mode that looked like "it keeps failing":
// with web search enabled, the model sometimes spends its entire
// max_tokens budget on extended thinking plus search round-trips and
// emits no visible text block at all. That's transient — an identical
// call a moment later usually succeeds — so retry once automatically
// rather than surfacing a confusing empty-response error to someone who
// just clicked Scan.
import fetch from "node-fetch";
import { extractFirstJsonArray, extractFirstJsonObject } from "./aiJson.js";

const MODEL = "claude-sonnet-5";

async function callOnce({ system, userMessage, maxTokens, useWebSearch }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMessage }],
  };
  if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Claude API request failed (${response.status})${errText ? `: ${errText.slice(0, 300)}` : ""}`);
  }
  const data = await response.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  // Web-search responses occasionally embed raw citation markup in the
  // visible text; strip it so it never reaches the UI as tag soup.
  return { text: text.replace(/<\/?cite[^>]*>/g, ""), stopReason: data.stop_reason };
}

async function callForJson(shape, opts) {
  const extract = shape === "array" ? extractFirstJsonArray : extractFirstJsonObject;
  let lastStopReason = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text, stopReason } = await callOnce(opts);
    lastStopReason = stopReason;
    if (text.trim()) return JSON.parse(extract(text));
    // Empty text — burned the budget on thinking/search. Retry once.
  }
  throw new Error(
    `The model spent its whole response budget researching without writing an answer (stop_reason: ${lastStopReason}). This is usually transient — try again.`
  );
}

export function callClaudeForJsonArray(opts) {
  return callForJson("array", { maxTokens: 6000, useWebSearch: true, ...opts });
}

export function callClaudeForJsonObject(opts) {
  return callForJson("object", { maxTokens: 6000, useWebSearch: true, ...opts });
}
