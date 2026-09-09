// AI-generated OPTIONS strategy ideas — same source:'ai' pattern as
// lib/tradeIdeas.js, but kept in its own file because options carry a
// meaningfully different risk/regulatory profile than equity ideas
// (leverage, time decay, assignment risk — brokers gate options trading
// behind a separate approval tier for exactly this reason).
//
// Deliberately does NOT fabricate strike prices, premiums, or expiration
// dates: live options-chain data isn't something web search reliably
// surfaces, and inventing precise numbers here would violate this app's
// core rule that an LLM never invents figures. Strategy-level ideas only,
// grounded in real context (earnings dates, position performance) — the
// person checks live pricing themselves in their own broker.
import fetch from "node-fetch";

export async function scanForOptionsIdeas(holdings) {
  if (!holdings.length) return [];

  const holdingsSummary = holdings
    .map((h) => `${h.ticker}: ${h.quantity} shares, market value $${h.market_value}, cost basis $${h.cost_basis}/share`)
    .join("; ");

  const system = `You are an options strategy analyst on a personal research desk. Review the person's actual equity holdings and current market context, and surface options STRATEGIES worth their research — covered calls on positions with a large unrealized gain, cash-secured puts on names they'd want to own more of on a dip, protective puts ahead of a known event (earnings, etc.), collars on a concentrated position. Only equity holdings can support an options strategy (covered calls/protective puts need existing shares) — don't suggest anything for a ticker they don't hold shares in.
Their current real holdings: ${holdingsSummary}.
Use web search for real current context — upcoming earnings dates, recent price action, why a strategy might fit right now.
CRITICAL — do not state or invent specific strike prices, premium amounts, or expiration dates as if they were live quotes. You have no reliable live options-chain data; naming a fake number would be exactly the kind of fabrication this app never does. Describe the strategy and the reasoning; tell the person to look up current strikes/premiums themselves in their own broker's options chain.
Respond with ONLY a JSON array (no markdown fences, no preamble), 0-3 items, each shaped exactly like:
{"ticker":"AAPL","strategy_type":"covered_call|cash_secured_put|protective_put|collar","summary":"2-3 sentence idea grounded in their real position and real current context — no invented strikes/premiums","rationale":"why this fits their situation now"}
Return an empty array [] if nothing genuinely fits — never manufacture an idea just to have one.
This is strategy research, not an instruction — the person evaluates suitability for their own account (options require separate broker approval) and places any trade themselves.`;

  const body = {
    model: "claude-sonnet-5",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: "What options strategies, if any, are worth me researching against my current holdings?" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  };

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
  const ideas = JSON.parse(extractFirstJsonArray(text));

  const STRATEGY_LABELS = {
    covered_call: "Covered Call",
    cash_secured_put: "Cash-Secured Put",
    protective_put: "Protective Put",
    collar: "Collar",
  };

  return ideas.map((idea) => ({
    category: `Options Idea — ${idea.ticker} ${STRATEGY_LABELS[idea.strategy_type] || idea.strategy_type}`,
    priority: "medium",
    confidence: "low", // strategy fit without live chain data — cap low, never higher
    financial_impact: null,
    explanation: idea.summary,
    supporting_data: { ticker: idea.ticker, strategy_type: idea.strategy_type, rationale: idea.rationale },
    recommended_next_step: `Options require separate approval from your broker. Look up current strikes/premiums for ${idea.ticker} yourself and evaluate against your own risk tolerance before doing anything — you place any trade yourself.`,
    specialist_review_required: true,
  }));
}

function extractFirstJsonArray(text) {
  const start = text.indexOf("[");
  if (start === -1) return "[]";
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
  return "[]";
}
