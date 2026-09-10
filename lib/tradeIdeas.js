// AI-generated trade ideas — deliberately kept separate from
// lib/opportunityEngine.js. Everything in that file is pure arithmetic on
// real data; everything here is a Claude judgment call informed by live web
// search. Both land in the `opportunities` table, but tagged source:'ai' so
// the UI never blurs "this is math" with "this is a model's opinion."
//
// This never places, sizes, or times an order — it produces ideas for the
// person to evaluate and execute themselves in their own brokerage, exactly
// like the existing analysis agents in lib/claude.js.
import fetch from "node-fetch";
import { extractFirstJsonArray } from "./aiJson.js";

export async function scanForTradeIdeas(holdings) {
  if (!holdings.length) return [];

  const holdingsSummary = holdings
    .map((h) => `${h.ticker}: ${h.quantity} shares, market value $${h.market_value}, cost basis $${h.cost_basis}/share`)
    .join("; ");

  const system = `You are a market-scanning analyst on a personal research desk. Your job: review the person's actual holdings against current market conditions and surface a SHORT list of specific, well-reasoned ideas worth their research this week — concentration trims, positions showing notable strength or weakness, sector/macro developments touching their holdings, or things worth watching.
This is research to prompt someone's own further homework, NOT a timing call — never frame anything as "get in now" or "get out by X," and never name a specific day or price level as an entry/exit trigger. The value here is the reasoning: explain the actual mechanism (why this matters, what would need to be true for the thesis to play out, what the real risk is), not just a headline conclusion.
Their current real holdings: ${holdingsSummary}.
Use web search for real, current information — don't invent prices, news, or dates.
Respond with ONLY a JSON array (no markdown fences, no preamble), 0-4 items, each shaped exactly like:
{"ticker":"AAPL","action_type":"trim|add|watch|hold","priority":"high|medium|low","summary":"3-4 sentence idea, specific and grounded in real current data, that actually explains the mechanism and what would need to be true — not just a headline","rationale":"the real market context you found, and specifically what risk or counter-argument someone should weigh before acting on this"}
Return an empty array [] if nothing genuinely stands out — never manufacture an idea just to have one.
Critical: never state or imply a specific share count, dollar amount, entry/exit price, or timing to place an order. This is analysis for a human to evaluate and act on themselves in their own brokerage account — not an instruction, and never place, size, or time a trade yourself.`;

  const body = {
    model: "claude-sonnet-5",
    // See lib/aiJson.js — 2000 was silently truncating verbose, well-
    // grounded responses (extended thinking + web search both eat into it).
    max_tokens: 6000,
    system,
    messages: [{ role: "user", content: "Scan my holdings and the current market. What's worth my attention today?" }],
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

  return ideas.map((idea) => ({
    category: `Trade Idea — ${idea.ticker}`,
    priority: ["high", "medium", "low"].includes(idea.priority) ? idea.priority : "medium",
    // AI judgment is never "high confidence" the way a deterministic
    // calculation is — cap it at medium regardless of what the model says.
    confidence: idea.confidence === "low" ? "low" : "medium",
    financial_impact: null,
    explanation: idea.summary,
    supporting_data: { ticker: idea.ticker, action_type: idea.action_type, rationale: idea.rationale },
    recommended_next_step: `Evaluate ${idea.ticker} yourself against your own goals and risk tolerance. If you agree, you place the trade — this app never does.`,
    specialist_review_required: true,
  }));
}
