import express from "express";
import { createLinkToken, exchangePublicToken, getInstitutionName, getInvestmentHoldings } from "../lib/plaid.js";
import { encryptToken, decryptToken } from "../lib/crypto.js";

const router = express.Router();

router.post("/link-token", async (req, res) => {
  try {
    const linkToken = await createLinkToken(req.session.userId);
    res.json({ link_token: linkToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Step 2: the browser hands back the one-time public_token from Link's
// onSuccess callback — exchange it server-side and store the real
// access_token encrypted, never sending it to the browser.
router.post("/exchange", async (req, res) => {
  const { public_token } = req.body;
  if (!public_token) return res.status(400).json({ error: "Missing public_token." });
  try {
    const { accessToken, itemId } = await exchangePublicToken(public_token);
    const institutionName = await getInstitutionName(itemId, accessToken);
    await req.db.query(
      "INSERT INTO plaid_connections (user_id, item_id, access_token, institution_name) VALUES ($1, $2, $3, $4)",
      [req.session.userId, itemId, encryptToken(accessToken), institutionName]
    );
    res.json({ ok: true, institution_name: institutionName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/connections", async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT id, institution_name, created_at FROM plaid_connections WHERE user_id = $1 ORDER BY created_at DESC",
    [req.session.userId]
  );
  res.json(rows);
});

// Pulls holdings from every connected Plaid item and replaces this user's
// Plaid-sourced rows — Schwab-sourced rows (source='schwab') are untouched.
router.post("/sync", async (req, res) => {
  try {
    const { rows: connections } = await req.db.query("SELECT * FROM plaid_connections WHERE user_id = $1", [
      req.session.userId,
    ]);
    if (!connections.length) return res.status(400).json({ error: "No accounts connected yet — click Connect to link one." });

    const allHoldings = [];
    for (const conn of connections) {
      const accessToken = decryptToken(conn.access_token);
      const holdings = await getInvestmentHoldings(accessToken);
      allHoldings.push(...holdings);
    }

    await req.db.query("DELETE FROM holdings WHERE user_id = $1 AND source = 'plaid'", [req.session.userId]);
    for (const h of allHoldings) {
      await req.db.query(
        `INSERT INTO holdings (user_id, source, ticker, quantity, market_value, cost_basis)
         VALUES ($1, 'plaid', $2, $3, $4, $5)`,
        [req.session.userId, h.ticker, h.quantity, h.market_value, h.cost_basis]
      );
    }
    res.json({ ok: true, message: `Synced ${allHoldings.length} position(s) from ${connections.length} account(s).` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
