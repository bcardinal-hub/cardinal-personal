import express from "express";
import fetch from "node-fetch";
import { encryptToken, decryptToken } from "../lib/crypto.js";

const router = express.Router();

const SCHWAB_AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const SCHWAB_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const SCHWAB_API_BASE = "https://api.schwabapi.com/trader/v1";

// Step 1: send the user to Schwab's real login page. This app never sees
// their Schwab password — Schwab redirects back with a one-time code.
router.get("/connect", (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.SCHWAB_CLIENT_ID,
    redirect_uri: process.env.SCHWAB_CALLBACK_URL,
    response_type: "code",
  });
  res.redirect(`${SCHWAB_AUTH_URL}?${params.toString()}`);
});

// Step 2: Schwab redirects back here with ?code=... — exchange it for
// access/refresh tokens and store them against this user, never the browser.
router.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing authorization code.");

  const basicAuth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const tokenResp = await fetch(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.SCHWAB_CALLBACK_URL,
    }),
  });

  if (!tokenResp.ok) return res.status(502).send("Schwab token exchange failed.");
  const tokens = await tokenResp.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await req.db.query(
    `INSERT INTO schwab_connections (user_id, access_token, refresh_token, access_token_expires_at)
     VALUES ($1, $2, $3, $4)`,
    [req.session.userId, encryptToken(tokens.access_token), encryptToken(tokens.refresh_token), expiresAt]
  );

  // Land back in the app itself (not a dead-end text page) so the wizard
  // picks up at the next step automatically.
  res.redirect("/?step=sync");
});

async function getFreshAccessToken(db, userId) {
  const { rows } = await db.query(
    "SELECT * FROM schwab_connections WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  const conn = rows[0];
  if (!conn) throw new Error("No Schwab account connected.");

  if (new Date(conn.access_token_expires_at) > new Date()) return decryptToken(conn.access_token);

  // Access token expired — use the refresh token to get a new one.
  const basicAuth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const resp = await fetch(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: decryptToken(conn.refresh_token) }),
  });
  if (!resp.ok) throw new Error("Failed to refresh Schwab token — user may need to reconnect.");
  const tokens = await resp.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await db.query(
    "UPDATE schwab_connections SET access_token = $1, refresh_token = $2, access_token_expires_at = $3, updated_at = now() WHERE id = $4",
    [encryptToken(tokens.access_token), encryptToken(tokens.refresh_token || decryptToken(conn.refresh_token)), expiresAt, conn.id]
  );
  return tokens.access_token;
}

// Pull current positions (read-only) and cache them locally. No trading
// endpoint is called anywhere in this file.
router.post("/sync", async (req, res) => {
  try {
    const accessToken = await getFreshAccessToken(req.db, req.session.userId);
    const accountsResp = await fetch(`${SCHWAB_API_BASE}/accounts?fields=positions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!accountsResp.ok) throw new Error("Failed to fetch positions from Schwab.");
    const accounts = await accountsResp.json();

    await req.db.query("DELETE FROM holdings WHERE user_id = $1 AND source = 'schwab'", [req.session.userId]);
    for (const account of accounts) {
      for (const pos of account.securitiesAccount?.positions || []) {
        await req.db.query(
          `INSERT INTO holdings (user_id, ticker, quantity, market_value, cost_basis, day_change, day_change_pct)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            req.session.userId,
            pos.instrument?.symbol,
            pos.longQuantity,
            pos.marketValue,
            pos.averagePrice,
            pos.currentDayProfitLoss,
            pos.currentDayProfitLossPercentage,
          ]
        );
      }
    }
    res.json({ ok: true, message: "Positions synced." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read-only view of the last synced positions, for the Positions tab.
router.get("/holdings", async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT ticker, source, quantity, market_value, cost_basis, day_change, day_change_pct, synced_at FROM holdings WHERE user_id = $1 ORDER BY market_value DESC NULLS LAST",
    [req.session.userId]
  );
  res.json(rows);
});

export default router;
