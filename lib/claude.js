import fetch from "node-fetch";
import { extractFirstJsonObject } from "./aiJson.js";

// The desk. Each role is its own Claude call with its own lens — same
// pattern as a real research/advisory floor split into specialists instead
// of one generalist. `noSearch: true` agents reason only over the holdings
// list already in the prompt (faster, no external dependency); everyone
// else uses web search and is expected to ground claims in real, current
// information rather than guessing.
const AGENTS = [
  { id: "fundamentals", label: "Head of Equity Research", focus: "Company fundamentals for the tickers held: recent earnings, margins, growth, valuation." },
  { id: "news", label: "News & Catalyst Desk", focus: "Recent news flow for the tickers held: earnings, guidance, ratings changes, major developments." },
  { id: "sentiment", label: "Sentiment Desk", focus: "Current investor sentiment for the tickers held, and whether it looks stretched either direction." },
  { id: "price_action", label: "Technical Strategist", focus: "Recent price behavior of the tickers held relative to their own range and relevant benchmarks." },
  {
    id: "portfolio",
    label: "Chief Portfolio Strategist",
    focus:
      "The household's overall holdings as a portfolio: concentration risk, diversification, cash levels, and anything that looks inconsistent with a typical risk-managed portfolio.",
    noSearch: true,
  },
  {
    id: "risk",
    label: "Chief Risk Officer",
    focus:
      "Position-level risk: single-name concentration, correlated bets (e.g. multiple holdings exposed to the same sector or factor), and anything a risk desk would flag before sizing up further. Blunt about what could go wrong, not just what looks good.",
    noSearch: true,
  },
  {
    id: "tax",
    label: "Tax Strategist",
    focus:
      "Tax efficiency of the current position list: unrealized losses worth harvesting, unrealized gains approaching (or already past) the long-term holding threshold, and wash-sale timing to watch. General framing only — never specific enough to substitute for a CPA.",
    noSearch: true,
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
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  // Web-search-enabled responses occasionally embed raw (cite index="...">
  // annotation markup directly in the visible text — strip it so it never
  // reaches the UI as literal tag soup (see the same fix in lib/aiJson.js).
  return text.replace(/<\/?cite[^>]*>/g, "");
}

export async function runAgent(agent, holdings) {
  const holdingsSummary = holdings
    .map((h) => {
      const costBasis = h.cost_basis != null ? Number(h.cost_basis) * Number(h.quantity || 0) : null;
      return `${h.ticker}: ${h.quantity} shares, market value $${h.market_value}${costBasis != null ? `, cost basis $${Math.round(costBasis)}` : ""}`;
    })
    .join("; ");

  const usesWebSearch = !agent.noSearch;
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
    // holdings list already in the prompt). Bumped from the original
    // 2000/1000 after finding extended thinking alone can eat 1000-1500+
    // tokens on top of visible output — see lib/aiJson.js for where this
    // exact failure mode silently corrupted a different set of agents.
    maxTokens: usesWebSearch ? 4000 : 2000,
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
    maxTokens: 4000,
    useWebSearch: true,
  });
  const parsed = JSON.parse(extractFirstJsonObject(text));
  return parsed.summary;
}

// Free-form chat for the AI Assistant tab. `history` is prior
// {role, content} turns (already persisted); `holdings` grounds the
// assistant in the user's real positions without it having to ask;
// `recommendations` are the desk's own recent findings (see AGENTS above)
// so the assistant can build on what the team already flagged instead of
// re-deriving it from scratch or, worse, contradicting a specialist.
export async function runChatTurn(history, holdings, recommendations = [], opportunities = []) {
  const holdingsSummary = holdings.length
    ? holdings
        .map((h) => {
          const costBasis = h.cost_basis != null ? Number(h.cost_basis) * Number(h.quantity || 0) : null;
          return `${h.ticker}: ${h.quantity} shares, market value $${h.market_value}${costBasis != null ? `, cost basis $${Math.round(costBasis)}` : ""}`;
        })
        .join("; ")
    : "none on file yet";

  const deskSummary = recommendations.length
    ? recommendations.map((r) => `[${r.agent}] ${r.summary}`).join("\n")
    : "No recent findings on file — the user hasn't run an analysis yet.";

  const ideasSummary = opportunities.length
    ? opportunities
        .map((o) => {
          const outcome = o.reviewed_at
            ? ` [Real outcome since callout: $${Number(o.price_at_callout).toFixed(2)} -> $${Number(o.price_at_review).toFixed(2)}, ${Number(o.pct_change) >= 0 ? "+" : ""}${Number(o.pct_change).toFixed(1)}%]`
            : "";
          return `[${o.category}] ${o.explanation}${outcome}`;
        })
        .join("\n")
    : "No recent trade/options/day-trading ideas on file.";

  const system = `You are the concierge for Cardinal Finance AI's research desk — the front door to a team of specialists (Equity Research, News & Catalysts, Sentiment, Technicals, Portfolio Strategy, Risk, Tax, Trade Ideas, Options, Market) who already analyze this person's real holdings, synced from Schwab or their bank/brokerage via Plaid.
This product exists for people who have real money and no background in investing — never assume familiarity with jargon. If you use a term a beginner might not know (P/E ratio, expense ratio, cost basis, concentration risk, wash sale, whatever), define it briefly in the same breath rather than assuming it or making them ask. When someone asks "what does X mean" or seems to be asking from genuine unfamiliarity rather than testing you, teach — don't just answer, explain the concept the way you'd want a smart friend to explain it to you the first time. This app also has a free Learn to Invest tab (guide + glossary, no subscription required) — point people there for a fuller primer when it fits naturally.
The user's current real holdings: ${holdingsSummary}.
Recent findings from the desk (most recent first) — build on these, reference the specialist by name when relevant, and don't contradict one without saying so:
${deskSummary}
Recent Trade Idea / Options / Day Trading callouts, with real graded outcomes where available (a real price then vs. now, not a self-assessment) — if the user asks how a past idea played out, this is the real answer, don't guess:
${ideasSummary}
Use web search when a question needs current information (quotes, news, rates, etc.) — don't guess or invent figures.
Be direct, concise, and specific to their actual holdings when relevant. Use plain language, not jargon.
${NEVER_TRADE_CLAUSE} If asked to place, size, or time a trade, explain that you can only help them think it through — they place every order themselves with their broker.`;

  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  // Chat doesn't JSON-parse its output, so truncation here doesn't throw —
  // it just means a reply that cuts off mid-sentence. Same headroom bump
  // as the other web-search-enabled calls, for the same reason.
  return await callClaude({ system, messages, maxTokens: 3000, useWebSearch: true });
}

export { AGENTS };
