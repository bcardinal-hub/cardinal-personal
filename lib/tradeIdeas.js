// AI-generated trade ideas — deliberately kept separate from
// lib/opportunityEngine.js. Everything in that file is pure arithmetic on
// real data; everything here is a Claude judgment call informed by live web
// search. Both land in the `opportunities` table, but tagged source:'ai' so
// the UI never blurs "this is math" with "this is a model's opinion."
//
// This never places, sizes, or times an order — it produces ideas for the
// person to evaluate and execute themselves in their own brokerage, exactly
// like the existing analysis agents in lib/claude.js.
import { callClaudeForJsonArray } from "./aiCall.js";

// `trackRecord` is a plain-text summary of how this same user's past
// callouts in this category actually played out (real price moves, not AI
// self-grading — see lib/trackRecord.js), or null if there isn't one yet.
// This is the actual mechanism behind "learn from past callouts": real
// historical context in the prompt, not model retraining.
//
// `maxPrice` is this specific user's own Trade Ideas price preference
// (users.trade_idea_max_price — adjustable per user, not a value hardcoded
// here for everyone). null/undefined means no preference stated.
export async function scanForTradeIdeas(holdings, trackRecord = null, maxPrice = null) {
  const holdingsSummary = holdings.length
    ? holdings.map((h) => `${h.ticker}: ${h.quantity} shares, market value $${h.market_value}, cost basis $${h.cost_basis}/share`).join("; ")
    : "none on file — base this purely on what's actually worth researching in the broader market today";

  const system = `You are a market-scanning analyst on a personal research desk. Your job: review the person's actual holdings AND scan the broader market, and surface a SHORT list of specific, well-reasoned ideas worth their research this week — concentration trims or notable strength/weakness on positions they already hold, but also genuinely new stock ideas they don't currently own, not just commentary on what's already in the portfolio.
${maxPrice ? `Price preference: this person specifically wants new ideas (action_type "add" or "watch" on a ticker they don't already hold) weighted toward stocks trading at or under roughly $${maxPrice}/share — smaller, more affordable names, not just mega-cap names they may already be overweight in. This preference is about NEW ideas; if something genuinely notable is happening in an existing holding regardless of its price, that's still worth surfacing as a "trim/hold" idea on that position.` : "No specific price preference on file — use your own judgment on what's genuinely worth surfacing, across any price range."}
This is research to prompt someone's own further homework, NOT a timing call — never frame anything as "get in now" or "get out by X," and never name a specific day or price level as an entry/exit trigger. The value here is the reasoning: explain the actual mechanism (why this matters, what would need to be true for the thesis to play out, what the real risk is), not just a headline conclusion.
Their current real holdings: ${holdingsSummary}.
${trackRecord ? `Your own real track record on past ideas in this category (real price moves since each callout, not a judgment call) — use this to calibrate, and don't repeat a pattern that hasn't worked:\n${trackRecord}\n` : ""}Use web search for real, current information — don't invent prices, news, or dates.${maxPrice ? ` A stock's real current price is exactly the kind of thing to verify via search before treating it as "under $${maxPrice}," not assume from memory.` : ""}
Respond with ONLY a JSON array (no markdown fences, no preamble), 0-4 items, each shaped exactly like:
{"ticker":"AAPL","action_type":"trim|add|watch|hold","priority":"high|medium|low","summary":"3-4 sentence idea, specific and grounded in real current data, that actually explains the mechanism and what would need to be true — not just a headline","rationale":"the real market context you found, and specifically what risk or counter-argument someone should weigh before acting on this"}
Return an empty array [] if nothing genuinely stands out — never manufacture an idea just to have one.
Critical: never state or imply a specific share count, dollar amount, entry/exit price, or timing to place an order. This is analysis for a human to evaluate and act on themselves in their own brokerage account — not an instruction, and never place, size, or time a trade yourself.`;

  const ideas = await callClaudeForJsonArray({
    system,
    userMessage: "Scan my holdings and the current market. What's worth my attention today?",
  });

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
