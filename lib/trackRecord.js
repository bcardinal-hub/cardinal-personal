// Deterministic outcome tracking for AI idea callouts (Trade Ideas, Options,
// Day Trading). Deliberately NOT AI-graded — a real Finnhub quote is
// captured at callout time and another once the review window has passed,
// and the resulting price move is shown as-is. Most of these ideas are
// conditional/bidirectional ("watch for a break above X or a hold above Y")
// rather than a clean up/down prediction, so imposing a "hit/miss" verdict
// would itself be a fabricated judgment — showing the real number and
// letting the person (and future prompts) draw their own conclusion is the
// honest version of "did this call actually play out."
import { getQuote } from "./finnhub.js";

// How long to wait before checking outcome — short for day trading (its
// whole premise is short-term), longer for the more research-oriented
// categories.
const REVIEW_WINDOW_DAYS = {
  "Day Trading Setup": 3,
  "Options Idea": 14,
  "Trade Idea": 14,
};

function windowForCategory(category) {
  for (const [prefix, days] of Object.entries(REVIEW_WINDOW_DAYS)) {
    if (category.startsWith(prefix)) return days;
  }
  return null; // not a category this system tracks (e.g. deterministic checks)
}

// Called right after inserting an AI opportunity that names a ticker —
// captures the price at the moment of the callout. Best-effort: a quote
// failure shouldn't fail the scan that's actually delivering the idea.
export async function recordCalloutPrice(db, opportunityId, ticker) {
  if (!ticker) return;
  try {
    const quote = await getQuote(ticker);
    if (!quote) return;
    await db.query("UPDATE opportunities SET price_at_callout = $1 WHERE id = $2", [quote.price, opportunityId]);
  } catch {
    // Non-fatal — the callout itself already succeeded and was shown to
    // the user; missing a price snapshot just means no track record entry.
  }
}

// Finds this user's AI opportunities whose review window has passed and
// don't have an outcome yet, fetches a current quote for each, and stores
// the result. Called lazily whenever opportunities are listed — same
// "nothing happens silently, triggered by an actual page load" pattern as
// the rest of this app, no cron/scheduler needed.
export async function reviewDueOutcomes(db, userId) {
  const { rows: due } = await db.query(
    `SELECT id, category, supporting_data, price_at_callout, created_at
     FROM opportunities
     WHERE user_id = $1 AND source = 'ai' AND price_at_callout IS NOT NULL AND reviewed_at IS NULL`,
    [userId]
  );
  for (const row of due) {
    const windowDays = windowForCategory(row.category);
    if (windowDays == null) continue;
    const dueAt = new Date(row.created_at).getTime() + windowDays * 24 * 3600 * 1000;
    if (Date.now() < dueAt) continue;

    const ticker = row.supporting_data?.ticker;
    if (!ticker) continue;
    try {
      const quote = await getQuote(ticker);
      if (!quote) continue;
      const pctChange = ((quote.price - row.price_at_callout) / row.price_at_callout) * 100;
      await db.query(
        "UPDATE opportunities SET price_at_review = $1, pct_change = $2, reviewed_at = now() WHERE id = $3",
        [quote.price, pctChange, row.id]
      );
    } catch {
      // Leave it for the next page load to retry.
    }
  }
}

// Builds a plain-text summary of this user's real, graded track record for
// one idea category — fed into that category's scan prompt as historical
// context. This is the actual mechanism behind "learn from past callouts":
// not model retraining, but giving the model its own recent real-world
// track record to calibrate against, the same way a human analyst would
// review their own past calls before making a new one.
export async function getTrackRecordSummary(db, userId, categoryPrefix, limit = 5) {
  const { rows } = await db.query(
    `SELECT category, explanation, price_at_callout, price_at_review, pct_change, reviewed_at
     FROM opportunities
     WHERE user_id = $1 AND source = 'ai' AND category LIKE $2 AND reviewed_at IS NOT NULL
     ORDER BY reviewed_at DESC LIMIT $3`,
    [userId, `${categoryPrefix}%`, limit]
  );
  if (!rows.length) return null;
  return rows
    .map((r) => {
      const sign = r.pct_change >= 0 ? "+" : "";
      return `${r.category}: called at $${Number(r.price_at_callout).toFixed(2)}, ${sign}${Number(r.pct_change).toFixed(1)}% by the time it was reviewed.`;
    })
    .join("\n");
}
