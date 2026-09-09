import fetch from "node-fetch";

const AGENTS = [
  { id: "fundamentals", label: "Fundamentals Analyst", focus: "Company fundamentals for the tickers held: recent earnings, margins, growth, valuation." },
  { id: "news", label: "News Analyst", focus: "Recent news flow for the tickers held: earnings, guidance, ratings changes, major developments." },
  { id: "sentiment", label: "Social Sentiment Analyst", focus: "Current investor sentiment for the tickers held, and whether it looks stretched either direction." },
  { id: "price_action", label: "Price Action Analyst", focus: "Recent price behavior of the tickers held relative to their own range and relevant benchmarks." },
  {
    id: "portfolio",
    label: "Portfolio Intelligence Agent",
    focus:
      "The household's overall holdings as a portfolio: concentration risk, diversification, cash levels, and anything that looks inconsistent with a typical risk-managed portfolio. This agent does not research external news — it reasons only over the position list it's given.",
  },
];

const NEVER_TRADE_CLAUSE =
  "This is analysis only — never suggest or imply that any trade should be placed automatically. The person reading this places their own trades themselves.";

// Low-level call. Returns the concatenated text blocks from the response.
async function callClaude({ system, messages, maxTokens, useWebSearch }) {
  const body = {
    model: "claude-sonnet-5",
    max_tokens: maxTokens,
    system,
    messages,
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
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

export async function runAgent(agent, holdings) {
  const holdingsSummary = holdings.map((h) => `${h.ticker}: ${h.quantity} shares, market value $${h.market_value}`).join("; ");

  const usesWebSearch = agent.id !== "portfolio";
  const system = `You are the ${agent.label} on a personal research desk. Your lens: ${agent.focus}
The user's current real holdings: ${holdingsSummary || "none on file yet"}.
${usesWebSearch ? "Use web search to find real, current information — don't guess or invent figures." : "Reason only over the holdings list above — no external research needed."}
Respond with ONLY a JSON object, no markdown fences, no preamble:
{"content_type":"ai_observation","summary":"2-3 sentence plain-language summary in your own words","confidence":"low|medium|high","specialist_review_required":false}
${NEVER_TRADE_CLAUSE}`;

  const text = await callClaude({
    system,
    messages: [{ role: "user", content: "Provide your analysis." }],
    // Search-enabled agents spend part of this budget on the search
    // round-trip itself before ever writing the JSON, so they get more
    // headroom than the portfolio agent (which only ever reasons over the
    // holdings list already in the prompt).
    maxTokens: usesWebSearch ? 2000 : 1000,
    useWebSearch: usesWebSearch,
  });
  return JSON.parse(extractFirstJsonObject(text));
}

const MARKET_SNAPSHOT_FOCUS = {
  overview: "Today's overall U.S. market action: major indices (S&P 500, Nasdaq, Dow), what's driving the tape, and the broad risk-on/risk-off tone.",
  news: "The most significant market-moving financial news of the last 24 hours across sectors — not tied to any one person's holdings.",
};

// Market/news snapshots are instance-wide, not per-user — see the comment
// on market_snapshots in db/schema.sql for why.
export async function runMarketSnapshot(kind) {
  const focus = MARKET_SNAPSHOT_FOCUS[kind];
  if (!focus) throw new Error(`Unknown snapshot kind: ${kind}`);

  const system = `You are a market desk analyst. Your focus right now: ${focus}
Use web search to find real, current information — don't guess or invent figures or dates.
Respond with ONLY a JSON object, no markdown fences, no preamble:
{"summary":"4-6 sentence plain-language roundup in your own words, safe to show a retail investor"}
${NEVER_TRADE_CLAUSE}`;

  const text = await callClaude({
    system,
    messages: [{ role: "user", content: "Provide today's snapshot." }],
    maxTokens: 2000,
    useWebSearch: true,
  });
  const parsed = JSON.parse(extractFirstJsonObject(text));
  return parsed.summary;
}

// Free-form chat for the AI Assistant tab. `history` is prior
// {role, content} turns (already persisted); `holdings` grounds the
// assistant in the user's real positions without it having to ask.
export async function runChatTurn(history, holdings) {
  const holdingsSummary = holdings.length
    ? holdings.map((h) => `${h.ticker}: ${h.quantity} shares, market value $${h.market_value}`).join("; ")
    : "none on file yet";

  const system = `You are the AI Assistant inside Cardinal Personal, a self-directed research copilot for one person's own real Schwab holdings.
The user's current real holdings: ${holdingsSummary}.
Use web search when a question needs current information (quotes, news, rates, etc.) — don't guess or invent figures.
Be direct, concise, and specific to their actual holdings when relevant. Use plain language, not jargon.
${NEVER_TRADE_CLAUSE} If asked to place, size, or time a trade, explain that you can only help them think it through — they place every order themselves in Schwab.`;

  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  return await callClaude({ system, messages, maxTokens: 1500, useWebSearch: true });
}

// Web-search-enabled responses sometimes add trailing commentary (which may
// itself contain braces) after the JSON object. A greedy {[\s\S]*} regex
// swallows that trailing text and fails to parse. Instead, scan from the
// first "{" and track brace depth (respecting strings/escapes) to find the
// exact end of that one JSON object.
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("Couldn't parse a structured response from the agent.");
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
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Couldn't parse a structured response from the agent.");
}

export { AGENTS };
