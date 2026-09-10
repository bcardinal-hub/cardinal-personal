import express from "express";
import { scanHousehold, scanPersonalPortfolio } from "../lib/opportunityEngine.js";
import { scanForTradeIdeas } from "../lib/tradeIdeas.js";
import { scanForOptionsIdeas } from "../lib/optionsIdeas.js";
import { scanForDayTradingIdeas } from "../lib/dayTradingIdeas.js";
import { requireSubscription, requirePro } from "../lib/paywall.js";
import { cooldown } from "../lib/cooldown.js";
import { recordCalloutPrice, reviewDueOutcomes, getTrackRecordSummary } from "../lib/trackRecord.js";

const router = express.Router();

// The deterministic checks are free to re-run, but the AI legs (trade
// ideas, options ideas) each spend a web-search-enabled Claude call —
// same unit-economics guard as /analysis/run.
const personalScanCooldown = cooldown({
  minutes: 10,
  label: "Personal opportunity scan",
  query: (req) =>
    req.db.query(
      "SELECT created_at FROM opportunities WHERE user_id = $1 AND household_id IS NULL ORDER BY created_at DESC LIMIT 1",
      [req.session.userId]
    ),
});
const optionsScanCooldown = cooldown({
  minutes: 10,
  label: "Options scan",
  query: (req) =>
    req.db.query(
      "SELECT created_at FROM opportunities WHERE user_id = $1 AND household_id IS NULL AND category LIKE 'Options Idea%' ORDER BY created_at DESC LIMIT 1",
      [req.session.userId]
    ),
});
const dayTradingScanCooldown = cooldown({
  minutes: 10,
  label: "Day trading scan",
  query: (req) =>
    req.db.query(
      "SELECT created_at FROM opportunities WHERE user_id = $1 AND household_id IS NULL AND category LIKE 'Day Trading Setup%' ORDER BY created_at DESC LIMIT 1",
      [req.session.userId]
    ),
});
const HOUSEHOLD_COOLDOWN_MINUTES = 10;

async function insertOpportunities(db, userId, householdId, found, source = "deterministic") {
  const inserted = [];
  for (const opp of found) {
    const { rows } = await db.query(
      `INSERT INTO opportunities (user_id, household_id, source, category, priority, confidence, financial_impact, explanation, supporting_data, recommended_next_step, specialist_review_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        userId,
        householdId,
        source,
        opp.category,
        opp.priority,
        opp.confidence,
        opp.financial_impact,
        opp.explanation,
        opp.supporting_data ? JSON.stringify(opp.supporting_data) : null,
        opp.recommended_next_step,
        opp.specialist_review_required,
      ]
    );
    // Track-record capture — best-effort, never blocks the scan response
    // itself. See lib/trackRecord.js. Reflected into the row we're about
    // to return so the client sees it immediately, not just on next load.
    if (source === "ai" && opp.supporting_data?.ticker) {
      rows[0].price_at_callout = await recordCalloutPrice(db, rows[0].id, opp.supporting_data.ticker);
    }
    inserted.push(rows[0]);
  }
  return inserted;
}

// ---- Household-scoped ----
// Cooldown is checked inline, after ownership is verified — the check
// itself reveals a household's scan timing, so it must never run before
// we've confirmed this advisor actually owns it.
router.post("/scan/household/:householdId", requireSubscription, async (req, res) => {
  const { rows: hhRows } = await req.db.query("SELECT * FROM households WHERE id = $1 AND advisor_id = $2", [
    req.params.householdId,
    req.session.userId,
  ]);
  const household = hhRows[0];
  if (!household) return res.status(404).json({ error: "Household not found." });

  const { rows: lastScan } = await req.db.query(
    "SELECT created_at FROM opportunities WHERE household_id = $1 ORDER BY created_at DESC LIMIT 1",
    [household.id]
  );
  const elapsedMs = lastScan[0] ? Date.now() - new Date(lastScan[0].created_at).getTime() : Infinity;
  const waitMs = HOUSEHOLD_COOLDOWN_MINUTES * 60 * 1000 - elapsedMs;
  if (waitMs > 0) {
    const waitMin = Math.max(1, Math.ceil(waitMs / 60000));
    return res.status(429).json({ error: `Household opportunity scan was run recently — try again in about ${waitMin} minute${waitMin === 1 ? "" : "s"}.` });
  }

  const [{ rows: clients }, { rows: accounts }, { rows: cashFlow }] = await Promise.all([
    req.db.query("SELECT * FROM clients WHERE household_id = $1", [household.id]),
    req.db.query("SELECT * FROM financial_accounts WHERE household_id = $1", [household.id]),
    req.db.query("SELECT * FROM cash_flow_items WHERE household_id = $1", [household.id]),
  ]);

  const found = scanHousehold({ ...household, clients, accounts, cashFlow });
  const inserted = await insertOpportunities(req.db, req.session.userId, household.id, found);
  res.json({ ok: true, found: inserted.length, opportunities: inserted });
});

router.get("/household/:householdId", async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT * FROM opportunities WHERE household_id = $1 AND user_id = $2 ORDER BY created_at DESC",
    [req.params.householdId, req.session.userId]
  );
  res.json(rows);
});

// ---- Personal-portfolio-scoped ----
// Runs both the deterministic checks and the AI trade-idea scan together —
// they're tagged with different `source` values so the UI never blurs
// "this is math" with "this is a model's opinion." The AI leg can fail
// independently (web search hiccup, rate limit, etc.) without losing the
// deterministic results.
router.post("/scan/personal", requireSubscription, personalScanCooldown, async (req, res) => {
  const [{ rows: holdings }, { rows: recommendations }, { rows: userRows }] = await Promise.all([
    req.db.query("SELECT * FROM holdings WHERE user_id = $1", [req.session.userId]),
    req.db.query("SELECT * FROM recommendations WHERE user_id = $1", [req.session.userId]),
    req.db.query("SELECT trade_idea_max_price FROM users WHERE id = $1", [req.session.userId]),
  ]);

  const deterministicFound = scanPersonalPortfolio({ holdings, recommendations });
  const deterministicInserted = await insertOpportunities(req.db, req.session.userId, null, deterministicFound, "deterministic");

  let aiInserted = [];
  let aiError = null;
  try {
    const trackRecord = await getTrackRecordSummary(req.db, req.session.userId, "Trade Idea");
    const maxPrice = userRows[0]?.trade_idea_max_price ? Number(userRows[0].trade_idea_max_price) : null;
    const aiFound = await scanForTradeIdeas(holdings, trackRecord, maxPrice);
    aiInserted = await insertOpportunities(req.db, req.session.userId, null, aiFound, "ai");
  } catch (e) {
    aiError = e.message;
  }

  const inserted = [...deterministicInserted, ...aiInserted];
  res.json({ ok: true, found: inserted.length, opportunities: inserted, aiError });
});

router.get("/personal", async (req, res) => {
  // Lazily grades any callouts whose review window has passed — no
  // scheduler needed, just runs whenever the list is actually viewed.
  await reviewDueOutcomes(req.db, req.session.userId);
  const { rows } = await req.db.query(
    "SELECT * FROM opportunities WHERE household_id IS NULL AND user_id = $1 ORDER BY created_at DESC",
    [req.session.userId]
  );
  res.json(rows);
});

// Separate, explicitly-triggered scan — options carry meaningfully more
// risk than the general trade ideas (leverage, assignment, time decay,
// and brokers gate options behind their own approval tier), so this never
// runs silently bundled into the general scan.
router.post("/scan/options", requirePro, optionsScanCooldown, async (req, res) => {
  const { rows: holdings } = await req.db.query("SELECT * FROM holdings WHERE user_id = $1", [req.session.userId]);
  try {
    const trackRecord = await getTrackRecordSummary(req.db, req.session.userId, "Options Idea");
    const found = await scanForOptionsIdeas(holdings, trackRecord);
    const inserted = await insertOpportunities(req.db, req.session.userId, null, found, "ai");
    res.json({ ok: true, found: inserted.length, opportunities: inserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Separate, explicitly-triggered scan — the highest-risk idea category this
// app produces (see lib/dayTradingIdeas.js for the full reasoning). Never
// bundled into the general scan; a person has to specifically ask for this.
router.post("/scan/daytrading", requirePro, dayTradingScanCooldown, async (req, res) => {
  const { rows: holdings } = await req.db.query("SELECT * FROM holdings WHERE user_id = $1", [req.session.userId]);
  try {
    const trackRecord = await getTrackRecordSummary(req.db, req.session.userId, "Day Trading Setup");
    const found = await scanForDayTradingIdeas(holdings, trackRecord);
    const inserted = await insertOpportunities(req.db, req.session.userId, null, found, "ai");
    res.json({ ok: true, found: inserted.length, opportunities: inserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Review actions (shared) ----
router.post("/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (!["approved", "edited", "rejected"].includes(action)) {
    return res.status(400).json({ error: "Action must be approved, edited, or rejected." });
  }
  const { rows } = await req.db.query(
    "UPDATE opportunities SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *",
    [action, id, req.session.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Opportunity not found." });
  await req.db.query("INSERT INTO audit_log (user_id, actor, action) VALUES ($1, $2, $3)", [
    req.session.userId,
    "You",
    `${action} opportunity #${id} (${rows[0].category})`,
  ]);
  res.json(rows[0]);
});

export default router;
