// AI-generated short-term/day-trading setups — the highest-risk category
// of idea this app produces, kept in its own file and its own explicitly-
// gated scan (same pattern as lib/optionsIdeas.js) rather than folded into
// the general Trade Ideas Desk, which deliberately stays timing-free.
//
// This app has no live intraday tick/quote feed — only Finnhub's latest
// price and whatever real, current context web search actually turns up.
// So "entry"/"exit" here are never invented precise numbers: they're real,
// searched technical levels (a moving average, a recent high/low, a
// support/resistance level actually cited by real sources) framed as
// conditions to watch, not directives. Confidence is capped at "low" no
// matter what the model reports — day-trading conditions move by the
// minute and this is, at best, a snapshot.
//
// Still never places, sizes, or times an order — same rule as every other
// idea generator in this app.
import fetch from "node-fetch";
import { extractFirstJsonArray } from "./aiJson.js";

export async function scanForDayTradingIdeas(holdings) {
  const holdingsSummary = holdings.length
    ? holdings.map((h) => `${h.ticker}: ${h.quantity} shares, market value $${h.market_value}`).join("; ")
    : "none on file — base this purely on what's actually active in the broader market today";

  const system = `You are a short-term/day-trading setup scanner on a personal research desk. This is explicitly the HIGHEST-RISK category of idea this app produces — the overwhelming majority of retail day traders lose money over time, and you should treat every idea you surface with that reality in mind, not as a promising opportunity dressed up in technical language.
Review the person's real holdings AND the broader market for names showing genuinely notable short-term setups today — real price action, real volume, a real news catalyst (earnings just reported, a major analyst move, a sector-wide event) found via web search.
Their current real holdings: ${holdingsSummary}.
Use web search for real, current data — real prices, real technical levels (moving averages, recent highs/lows, support/resistance actually cited by real sources), real catalysts, real dates. NEVER invent a specific price, level, or number you don't have real current data for — if you can't find a real grounded level, don't include a number, describe the condition in words instead.
Respond with ONLY a JSON array (no markdown fences, no preamble), 0-3 items, each shaped exactly like:
{"ticker":"AAPL","setup":"what's actually happening right now, grounded in real data you found","watch_for_entry":"a real, searched technical condition/level to watch — described as a condition ('a break above X' or 'a pullback toward the Y level'), never a directive to buy at a specific time","watch_for_exit":"a real risk-management framing — where a disciplined trader would typically consider a stop-loss or take profit, as a concept, never a directive","risk_note":"the specific way this idea could go wrong"}
Return an empty array [] if nothing genuinely stands out — never manufacture a setup just to have one, and err toward fewer, better ideas over filling the list.
Critical: never state or imply a specific share count, dollar amount, or exact time to place an order. This is research for a human to evaluate against their own real-time charts and risk tolerance — not an instruction, and never places, sizes, or times a trade itself.`;

  const body = {
    model: "claude-sonnet-5",
    // Grounded, verbose per-idea reasoning plus web search round-trips
    // plus extended thinking easily exceeds 2000 — that was silently
    // truncating real responses (see extractFirstJsonArray in lib/aiJson.js).
    max_tokens: 6000,
    system,
    messages: [{ role: "user", content: "Scan for short-term setups worth watching today, across my holdings and the broader market." }],
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
    category: `Day Trading Setup — ${idea.ticker}`,
    priority: "medium",
    // Always low — never let the model's own stated confidence through
    // here. A day-old snapshot is a weak basis for anything time-sensitive.
    confidence: "low",
    financial_impact: null,
    explanation: `${idea.setup} Watch for: ${idea.watch_for_entry} Risk-management framing: ${idea.watch_for_exit}`,
    supporting_data: { ticker: idea.ticker, watch_for_entry: idea.watch_for_entry, watch_for_exit: idea.watch_for_exit, risk_note: idea.risk_note },
    recommended_next_step: `Check real-time charts and current pricing yourself before doing anything — this is a snapshot, not live data. Most retail day traders lose money over time; size any position accordingly. You place any trade yourself, at a time and price you verify.`,
    specialist_review_required: true,
  }));
}
