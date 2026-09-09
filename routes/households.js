import express from "express";

const router = express.Router();

// Loads the household for :householdId and 404s if it doesn't exist or
// doesn't belong to the signed-in advisor — every nested route below reuses
// this so no household ever leaks across advisors.
async function loadHousehold(req, res, next) {
  const { rows } = await req.db.query("SELECT * FROM households WHERE id = $1 AND advisor_id = $2", [
    req.params.householdId,
    req.session.userId,
  ]);
  if (!rows[0]) return res.status(404).json({ error: "Household not found." });
  req.household = rows[0];
  next();
}

function netWorth({ accounts, cashFlow }) {
  const assets = accounts.filter((a) => !a.is_liability).reduce((sum, a) => sum + Number(a.balance || 0), 0);
  const liabilities = accounts.filter((a) => a.is_liability).reduce((sum, a) => sum + Number(a.balance || 0), 0);
  const monthlyIncome = cashFlow.filter((c) => c.kind === "income").reduce((sum, c) => sum + Number(c.monthly_amount || 0), 0);
  const monthlyExpenses = cashFlow.filter((c) => c.kind === "expense").reduce((sum, c) => sum + Number(c.monthly_amount || 0), 0);
  return { assets, liabilities, net_worth: assets - liabilities, monthlyIncome, monthlyExpenses, monthlyCashFlow: monthlyIncome - monthlyExpenses };
}

// ---- Households ----
router.get("/", async (req, res) => {
  const { rows: households } = await req.db.query(
    "SELECT * FROM households WHERE advisor_id = $1 ORDER BY created_at DESC",
    [req.session.userId]
  );
  // One extra query per household is fine at personal-advisor scale; revisit
  // with a single aggregated query if this instance ever tracks hundreds.
  const withSummary = await Promise.all(
    households.map(async (h) => {
      const [{ rows: clients }, { rows: accounts }, { rows: cashFlow }] = await Promise.all([
        req.db.query("SELECT id, full_name, relationship FROM clients WHERE household_id = $1", [h.id]),
        req.db.query("SELECT balance, is_liability FROM financial_accounts WHERE household_id = $1", [h.id]),
        req.db.query("SELECT kind, monthly_amount FROM cash_flow_items WHERE household_id = $1", [h.id]),
      ]);
      return { ...h, clients, ...netWorth({ accounts, cashFlow }) };
    })
  );
  res.json(withSummary);
});

router.post("/", async (req, res) => {
  const { name, advisor_notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Household name required." });
  const { rows } = await req.db.query(
    "INSERT INTO households (advisor_id, name, advisor_notes) VALUES ($1, $2, $3) RETURNING *",
    [req.session.userId, name.trim(), advisor_notes || null]
  );
  res.json(rows[0]);
});

router.get("/:householdId", loadHousehold, async (req, res) => {
  const [{ rows: clients }, { rows: goals }, { rows: accounts }, { rows: cashFlow }] = await Promise.all([
    req.db.query("SELECT * FROM clients WHERE household_id = $1 ORDER BY relationship, full_name", [req.household.id]),
    req.db.query("SELECT * FROM goals WHERE household_id = $1 ORDER BY target_date NULLS LAST", [req.household.id]),
    req.db.query("SELECT * FROM financial_accounts WHERE household_id = $1 ORDER BY is_liability, category", [req.household.id]),
    req.db.query("SELECT * FROM cash_flow_items WHERE household_id = $1 ORDER BY kind, name", [req.household.id]),
  ]);
  res.json({ ...req.household, clients, goals, accounts, cashFlow, ...netWorth({ accounts, cashFlow }) });
});

const HOUSEHOLD_FIELDS = [
  "name", "advisor_notes",
  "has_will", "has_trust", "has_poa", "beneficiaries_current",
  "life_insurance", "disability_insurance", "umbrella_insurance", "ltc_insurance",
];

router.patch("/:householdId", loadHousehold, async (req, res) => {
  // Explicit "not present in body" vs "present and null" matters here — the
  // estate/insurance fields are genuinely tri-state (true/false/unknown), so
  // a plain COALESCE would make it impossible to ever set one back to
  // "unknown." Only touch fields the client actually sent.
  const updates = HOUSEHOLD_FIELDS.filter((f) => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: "No fields to update." });
  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(", ");
  const values = updates.map((f) => (f === "name" ? req.body[f]?.trim() : req.body[f]));
  const { rows } = await req.db.query(
    `UPDATE households SET ${setClause}, updated_at = now() WHERE id = $${updates.length + 1} RETURNING *`,
    [...values, req.household.id]
  );
  res.json(rows[0]);
});

router.delete("/:householdId", loadHousehold, async (req, res) => {
  await req.db.query("DELETE FROM households WHERE id = $1", [req.household.id]);
  res.json({ ok: true });
});

// ---- Clients (people within a household) ----
router.post("/:householdId/clients", loadHousehold, async (req, res) => {
  const { full_name, relationship, date_of_birth, employment_status, annual_income, risk_tolerance, retirement_target_age } = req.body;
  if (!full_name || !full_name.trim()) return res.status(400).json({ error: "Client name required." });
  const { rows } = await req.db.query(
    `INSERT INTO clients (household_id, full_name, relationship, date_of_birth, employment_status, annual_income, risk_tolerance, retirement_target_age)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      req.household.id,
      full_name.trim(),
      relationship || "primary",
      date_of_birth || null,
      employment_status || null,
      annual_income || null,
      risk_tolerance || null,
      retirement_target_age || null,
    ]
  );
  res.json(rows[0]);
});

router.patch("/:householdId/clients/:clientId", loadHousehold, async (req, res) => {
  const fields = ["full_name", "relationship", "date_of_birth", "employment_status", "annual_income", "risk_tolerance", "retirement_target_age"];
  const updates = fields.filter((f) => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: "No fields to update." });
  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(", ");
  const values = updates.map((f) => req.body[f]);
  const { rows } = await req.db.query(
    `UPDATE clients SET ${setClause}, updated_at = now() WHERE id = $${updates.length + 1} AND household_id = $${updates.length + 2} RETURNING *`,
    [...values, req.params.clientId, req.household.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Client not found." });
  res.json(rows[0]);
});

router.delete("/:householdId/clients/:clientId", loadHousehold, async (req, res) => {
  await req.db.query("DELETE FROM clients WHERE id = $1 AND household_id = $2", [req.params.clientId, req.household.id]);
  res.json({ ok: true });
});

// ---- Financial accounts (assets & liabilities) ----
router.post("/:householdId/accounts", loadHousehold, async (req, res) => {
  const { category, is_liability, name, balance, notes } = req.body;
  if (!category || !name) return res.status(400).json({ error: "Category and name required." });
  const { rows } = await req.db.query(
    `INSERT INTO financial_accounts (household_id, category, is_liability, name, balance, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.household.id, category, !!is_liability, name, balance || 0, notes || null]
  );
  res.json(rows[0]);
});

router.patch("/:householdId/accounts/:accountId", loadHousehold, async (req, res) => {
  const fields = ["category", "is_liability", "name", "balance", "notes"];
  const updates = fields.filter((f) => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: "No fields to update." });
  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(", ");
  const values = updates.map((f) => req.body[f]);
  const { rows } = await req.db.query(
    `UPDATE financial_accounts SET ${setClause}, updated_at = now() WHERE id = $${updates.length + 1} AND household_id = $${updates.length + 2} RETURNING *`,
    [...values, req.params.accountId, req.household.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Account not found." });
  res.json(rows[0]);
});

router.delete("/:householdId/accounts/:accountId", loadHousehold, async (req, res) => {
  await req.db.query("DELETE FROM financial_accounts WHERE id = $1 AND household_id = $2", [req.params.accountId, req.household.id]);
  res.json({ ok: true });
});

// ---- Cash flow (income / expenses) ----
router.post("/:householdId/cashflow", loadHousehold, async (req, res) => {
  const { kind, name, monthly_amount } = req.body;
  if (!kind || !name) return res.status(400).json({ error: "Kind and name required." });
  const { rows } = await req.db.query(
    "INSERT INTO cash_flow_items (household_id, kind, name, monthly_amount) VALUES ($1, $2, $3, $4) RETURNING *",
    [req.household.id, kind, name, monthly_amount || 0]
  );
  res.json(rows[0]);
});

router.delete("/:householdId/cashflow/:itemId", loadHousehold, async (req, res) => {
  await req.db.query("DELETE FROM cash_flow_items WHERE id = $1 AND household_id = $2", [req.params.itemId, req.household.id]);
  res.json({ ok: true });
});

// ---- Goals ----
router.post("/:householdId/goals", loadHousehold, async (req, res) => {
  const { description, target_amount, target_date } = req.body;
  if (!description) return res.status(400).json({ error: "Description required." });
  const { rows } = await req.db.query(
    "INSERT INTO goals (household_id, description, target_amount, target_date) VALUES ($1, $2, $3, $4) RETURNING *",
    [req.household.id, description, target_amount || null, target_date || null]
  );
  res.json(rows[0]);
});

router.patch("/:householdId/goals/:goalId", loadHousehold, async (req, res) => {
  const { status } = req.body;
  if (!["active", "achieved", "abandoned"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  const { rows } = await req.db.query(
    "UPDATE goals SET status = $1 WHERE id = $2 AND household_id = $3 RETURNING *",
    [status, req.params.goalId, req.household.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Goal not found." });
  res.json(rows[0]);
});

router.delete("/:householdId/goals/:goalId", loadHousehold, async (req, res) => {
  await req.db.query("DELETE FROM goals WHERE id = $1 AND household_id = $2", [req.params.goalId, req.household.id]);
  res.json({ ok: true });
});

export default router;
