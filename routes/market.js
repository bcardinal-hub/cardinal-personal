import express from "express";
import { runMarketSnapshot } from "../lib/claude.js";
import { INDEX_PROXIES, WATCHLIST, SECTOR_PROXIES, getQuotes, getMarketNews, getCompanyNews, getEarningsCalendar } from "../lib/finnhub.js";
import { requireSubscription } from "../lib/paywall.js";
import { cooldown } from "../lib/cooldown.js";

const router = express.Router();

// Snapshots are shared instance-wide (see the comment on /:kind below) —
// one person mashing Refresh spends every subscriber's shared Claude
// budget, so this cooldown matters more than the per-user ones elsewhere.
const refreshCooldown = cooldown({
  minutes: 5,
  label: "Refresh",
  query: (req) =>
    req.db.query(
      "SELECT created_at FROM market_snapshots WHERE kind = $1 ORDER BY created_at DESC LIMIT 1",
      [req.params.kind]
    ),
});
const VALID_KINDS = new Set(["overview", "news"]);

function checkKind(req, res, next) {
  if (!VALID_KINDS.has(req.params.kind)) return res.status(400).json({ error: "Unknown snapshot kind." });
  next();
}

// Real, live quotes — major indices (via ETF proxies) plus whatever this
// user actually holds. No caching layer: this is meant to be genuinely
// live, refreshed whenever the tab is viewed/polled.
router.get("/quotes", async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) return res.status(400).json({ error: "Market data isn't configured yet (FINNHUB_API_KEY missing)." });
  try {
    const { rows: holdings } = await req.db.query(
      "SELECT DISTINCT ticker FROM holdings WHERE user_id = $1",
      [req.session.userId]
    );
    const holdingSymbols = holdings.map((h) => h.ticker).filter((t) => /^[A-Z.]{1,6}$/.test(t)); // skip option/OTC-style symbols Finnhub won't resolve
    const [indices, watchlist, yours] = await Promise.all([
      getQuotes(INDEX_PROXIES.map((i) => i.symbol)),
      getQuotes(WATCHLIST),
      getQuotes(holdingSymbols),
    ]);
    const labelBySymbol = Object.fromEntries(INDEX_PROXIES.map((i) => [i.symbol, i.label]));
    const allIndices = [
      ...indices.map((q) => ({ ...q, label: labelBySymbol[q.symbol] })),
      ...watchlist.map((q) => ({ ...q, label: q.symbol })),
    ];
    res.json({
      indices: allIndices,
      holdings: yours,
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sector breadth — real data, sorted best-to-worst, no caching (same "make
// it actually live" rule as /quotes). Registered ahead of the /:kind
// catch-all below so it isn't swallowed by that dynamic route.
router.get("/sectors", async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) return res.status(400).json({ error: "Market data isn't configured yet (FINNHUB_API_KEY missing)." });
  try {
    const quotes = await getQuotes(SECTOR_PROXIES.map((s) => s.symbol));
    const labelBySymbol = Object.fromEntries(SECTOR_PROXIES.map((s) => [s.symbol, s.label]));
    const sectors = quotes
      .map((q) => ({ ...q, label: labelBySymbol[q.symbol] }))
      .sort((a, b) => b.changePct - a.changePct);
    res.json({ sectors, asOf: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upcoming earnings dates for the tickers this person actually holds —
// the most directly actionable thing on the Market tab, since an earnings
// date is a known, dated event on their own money. Registered ahead of
// the /:kind catch-all below.
router.get("/earnings", async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) return res.status(400).json({ error: "Market data isn't configured yet (FINNHUB_API_KEY missing)." });
  try {
    const { rows: holdings } = await req.db.query(
      "SELECT DISTINCT ticker FROM holdings WHERE user_id = $1",
      [req.session.userId]
    );
    const symbols = holdings.map((h) => h.ticker).filter((t) => /^[A-Z.]{1,6}$/.test(t)).slice(0, 15);
    const earnings = await getEarningsCalendar(symbols);
    res.json({ earnings, asOf: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Real news — general market headlines plus per-holding company news,
// merged and sorted. Never LLM-paraphrased; these are real articles with
// real sources/links.
router.get("/news-feed", async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) return res.status(400).json({ error: "News isn't configured yet (FINNHUB_API_KEY missing)." });
  try {
    const { rows: holdings } = await req.db.query(
      "SELECT DISTINCT ticker FROM holdings WHERE user_id = $1",
      [req.session.userId]
    );
    const holdingSymbols = holdings.map((h) => h.ticker).filter((t) => /^[A-Z.]{1,6}$/.test(t)).slice(0, 8);
    const [general, perCompany] = await Promise.all([
      getMarketNews(15),
      Promise.all(holdingSymbols.map((s) => getCompanyNews(s, 3).catch(() => []))),
    ]);
    const merged = [...general, ...perCompany.flat()]
      .filter((item) => item.headline)
      .sort((a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0));
    // De-dupe by headline — general and company feeds often overlap.
    const seen = new Set();
    const deduped = merged.filter((item) => (seen.has(item.headline) ? false : (seen.add(item.headline), true)));
    res.json({ articles: deduped.slice(0, 30), asOf: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Market/news snapshots are instance-wide (not per-user) — read the latest
// cached snapshot instantly, never triggering a Claude call on page load.
router.get("/:kind", checkKind, async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT summary, created_at FROM market_snapshots WHERE kind = $1 ORDER BY created_at DESC LIMIT 1",
    [req.params.kind]
  );
  res.json({ snapshot: rows[0] || null });
});

// Explicit, human-triggered refresh — this is the only thing that spends an
// API call here, same "nothing happens silently" rule as /analysis/run.
// Gated even though the snapshot is shared instance-wide: without this, a
// free account could spend the whole instance's Claude budget just by
// mashing Refresh.
router.post("/:kind/refresh", requireSubscription, checkKind, refreshCooldown, async (req, res) => {
  try {
    const summary = await runMarketSnapshot(req.params.kind);
    const { rows } = await req.db.query(
      "INSERT INTO market_snapshots (kind, summary) VALUES ($1, $2) RETURNING summary, created_at",
      [req.params.kind, summary]
    );
    res.json({ snapshot: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
