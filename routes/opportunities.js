import express from "express";
import { scanHousehold, scanPersonalPortfolio } from "../lib/opportunityEngine.js";
import { scanForTradeIdeas } from "../lib/tradeIdeas.js";
import { scanForOptionsIdeas } from "../lib/optionsIdeas.js";
import { requireSubscription } from "../lib/paywall.js";

const router = express.Router();

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
    inserted.push(rows[0]);
  }
  return inserted;
}

// ---- Household-scoped ----
router.post("/scan/household/:householdId", requireSubscription, async (req, res) => {
  const { rows: hhRows } = await req.db.query("SELECT * FROM households WHERE id = $1 AND advisor_id = $2", [
    req.params.householdId,
    req.session.userId,
  ]);
  const household = hhRows[0];
  if (!household) return res.status(404).json({ error: "Household not found." });

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
router.post("/scan/personal", requireSubscription, async (req, res) => {
  const [{ rows: holdings }, { rows: recommendations }] = await Promise.all([
    req.db.query("SELECT * FROM holdings WHERE user_id = $1", [req.session.userId]),
    req.db.query("SELECT * FROM recommendations WHERE user_id = $1", [req.session.userId]),
  ]);

  const deterministicFound = scanPersonalPortfolio({ holdings, recommendations });
  const deterministicInserted = await insertOpportunities(req.db, req.session.userId, null, deterministicFound, "deterministic");

  let aiInserted = [];
  let aiError = null;
  try {
    const aiFound = await scanForTradeIdeas(holdings);
    aiInserted = await insertOpportunities(req.db, req.session.userId, null, aiFound, "ai");
  } catch (e) {
    aiError = e.message;
  }

  const inserted = [...deterministicInserted, ...aiInserted];
  res.json({ ok: true, found: inserted.length, opportunities: inserted, aiError });
});

router.get("/personal", async (req, res) => {
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
router.post("/scan/options", requireSubscription, async (req, res) => {
  const { rows: holdings } = await req.db.query("SELECT * FROM holdings WHERE user_id = $1", [req.session.userId]);
  try {
    const found = await scanForOptionsIdeas(holdings);
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
