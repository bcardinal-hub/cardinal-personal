import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { cancelSubscriptionImmediately } from "../lib/stripe.js";
import { removeItem } from "../lib/plaid.js";
import { decryptToken } from "../lib/crypto.js";
import { sendPasswordResetEmail, sendLoginCodeEmail } from "../lib/email.js";
import { rateLimit } from "../lib/rateLimit.js";
import { personalRetirementOutlook } from "../lib/opportunityEngine.js";

const router = express.Router();

// Brute-force/spam protection, per IP. Login is the tightest (credential
// guessing is the real risk); signup and forgot-password are looser but
// still capped (mass account creation, email-bombing an address).
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, label: "login" });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, label: "signup" });
const forgotPasswordLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, label: "password reset" });
const verifyCodeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, label: "sign-in code" });
const resendCodeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 3, label: "sign-in code resend" });

// Hash the raw token the same way on both ends (request + reset) — never
// store or compare the raw value server-side, same principle as a password.
function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

const SALT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : raw;
}

// ---- Email sign-in code (consumer MFA) ----
// With REQUIRE_LOGIN_CODE on, a correct password no longer creates a
// session. It parks the user as pendingUserId and emails a 6-digit code;
// only verifying that code sets req.session.userId — so requireLogin, and
// Plaid Link behind it, can't be reached on a password alone. Off by
// default so it can't be enabled before email actually reaches every user
// (see EMAIL_FROM in lib/email.js).
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_MAX_ATTEMPTS = 5;

function loginCodeRequired() {
  return process.env.REQUIRE_LOGIN_CODE === "true";
}

// Keyed with the session secret rather than a bare SHA-256: a 6-digit code
// has only a million possibilities, so an unkeyed hash in a leaked database
// would be reversed instantly.
function hashLoginCode(userId, code) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET).update(`${userId}:${code}`).digest("hex");
}

async function issueLoginCode(db, userId, email) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query(
    "UPDATE users SET login_code_hash = $1, login_code_expires = $2, login_code_attempts = 0 WHERE id = $3",
    [hashLoginCode(userId, code), new Date(Date.now() + LOGIN_CODE_TTL_MS), userId]
  );
  await sendLoginCodeEmail(email, code);
}

// Called once the password step has passed (login) or the account was just
// created (signup, where the code doubles as proof the email is theirs).
async function completePasswordStep(req, res, userId, email) {
  if (!loginCodeRequired()) {
    req.session.userId = userId;
    return res.json({ ok: true });
  }
  try {
    await issueLoginCode(req.db, userId, email);
  } catch (e) {
    console.error("Sign-in code email failed:", e.message);
    return res.status(502).json({ error: "We couldn't send your sign-in code just now — try again in a minute." });
  }
  // A pending sign-in replaces any existing session identity, so logging in
  // as someone else can't leave the previous account half-signed-in.
  delete req.session.userId;
  req.session.pendingUserId = userId;
  res.json({ ok: true, codeRequired: true });
}

router.post("/signup", signupLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "That doesn't look like a valid email." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  let userId;
  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await req.db.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, passwordHash]
    );
    userId = result.rows[0].id;
  } catch (e) {
    return res.status(400).json({ error: "Could not create account — email may already be in use." });
  }
  await completePasswordStep(req, res, userId, email);
});

router.post("/login", loginLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  const result = await req.db.query("SELECT id, password_hash FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
  // Run bcrypt.compare even on a missing user (against a dummy hash) so a
  // nonexistent-email request takes about as long as a wrong-password one —
  // otherwise the timing difference leaks which emails have accounts.
  const dummyHash = "$2a$12$C6UzMDM.H6dfI/f/IKcEeOMkyMS/6cRB1YfWPT9hCT/mZOl9fCkvC";
  const valid = await bcrypt.compare(password, user?.password_hash || dummyHash);
  if (!user || !valid) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  await completePasswordStep(req, res, user.id, email);
});

router.post("/verify-code", verifyCodeLimiter, async (req, res) => {
  const pendingUserId = req.session.pendingUserId;
  if (!pendingUserId) return res.status(401).json({ error: "Your sign-in expired — log in again." });
  const code = typeof req.body.code === "string" ? req.body.code.replace(/\D/g, "") : "";
  if (code.length !== 6) return res.status(400).json({ error: "Enter the 6-digit code from your email." });

  const { rows } = await req.db.query(
    "SELECT login_code_hash, login_code_expires, login_code_attempts FROM users WHERE id = $1",
    [pendingUserId]
  );
  const u = rows[0];
  if (!u?.login_code_hash || new Date(u.login_code_expires) < new Date()) {
    return res.status(400).json({ error: "That code expired — tap “Send a new code”." });
  }
  if (u.login_code_attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Too many wrong tries — tap “Send a new code”." });
  }
  const expected = Buffer.from(u.login_code_hash, "hex");
  const given = Buffer.from(hashLoginCode(pendingUserId, code), "hex");
  if (!crypto.timingSafeEqual(expected, given)) {
    await req.db.query("UPDATE users SET login_code_attempts = login_code_attempts + 1 WHERE id = $1", [pendingUserId]);
    return res.status(401).json({ error: "That code isn't right — check the newest email and try again." });
  }

  // Single-use: burn the code before creating the session.
  await req.db.query(
    "UPDATE users SET login_code_hash = NULL, login_code_expires = NULL, login_code_attempts = 0 WHERE id = $1",
    [pendingUserId]
  );
  // New session id at the moment of sign-in, so a session id planted before
  // login (session fixation) is worthless afterward.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Could not start your session — try again." });
    req.session.userId = pendingUserId;
    res.json({ ok: true });
  });
});

router.post("/resend-code", resendCodeLimiter, async (req, res) => {
  const pendingUserId = req.session.pendingUserId;
  if (!pendingUserId) return res.status(401).json({ error: "Your sign-in expired — log in again." });
  const { rows } = await req.db.query("SELECT email FROM users WHERE id = $1", [pendingUserId]);
  if (!rows[0]) return res.status(401).json({ error: "Your sign-in expired — log in again." });
  try {
    await issueLoginCode(req.db, pendingUserId, rows[0].email);
  } catch (e) {
    console.error("Sign-in code email failed:", e.message);
    return res.status(502).json({ error: "We couldn't send a new code just now — try again in a minute." });
  }
  res.json({ ok: true });
});

// Always responds {ok:true} regardless of whether the email exists — same
// anti-enumeration principle as the timing-safe check in /login. An
// attacker probing emails shouldn't be able to tell which ones have
// accounts just by whether a reset was sent.
router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) return res.status(400).json({ error: "Email required." });

  const { rows } = await req.db.query("SELECT id FROM users WHERE email = $1", [email]);
  const user = rows[0];
  if (user) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await req.db.query(
      "UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3",
      [hashToken(rawToken), expires, user.id]
    );
    const origin = `${req.protocol}://${req.get("host")}`;
    const resetUrl = `${origin}/?reset=${rawToken}`;
    try {
      await sendPasswordResetEmail(email, resetUrl);
    } catch (e) {
      // Don't leak email-delivery failures to the client — that would both
      // reveal whether the address exists and expose config errors. Log
      // server-side only.
      console.error("Password reset email failed:", e.message);
    }
  }
  res.json({ ok: true });
});

router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and new password required." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const { rows } = await req.db.query(
    "SELECT id, reset_token_expires FROM users WHERE reset_token_hash = $1",
    [hashToken(token)]
  );
  const user = rows[0];
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: "That reset link is invalid or has expired — request a new one." });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await req.db.query(
    "UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2",
    [passwordHash, user.id]
  );
  // With sign-in codes on, they sign in normally afterward — auto-login here
  // would let the reset link alone skip the second factor. Without codes,
  // the emailed link already proved ownership, so log them straight in.
  if (loginCodeRequired()) return res.json({ ok: true, signInRequired: true });
  req.session.userId = user.id;
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Per-user preferences — not covered by requireLogin for the same reason
// as delete-account above. Currently just the Trade Ideas price
// preference; a real, adjustable setting per user rather than a value
// hardcoded into the prompt for everyone.
router.get("/preferences", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  const { rows } = await req.db.query("SELECT trade_idea_max_price FROM users WHERE id = $1", [req.session.userId]);
  res.json({ tradeIdeaMaxPrice: rows[0]?.trade_idea_max_price ?? null });
});

router.patch("/preferences", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  const { tradeIdeaMaxPrice } = req.body;
  // Explicit null clears the preference (no price constraint); anything
  // else must be a positive number.
  if (tradeIdeaMaxPrice !== null && (typeof tradeIdeaMaxPrice !== "number" || tradeIdeaMaxPrice <= 0)) {
    return res.status(400).json({ error: "Price must be a positive number, or null to clear it." });
  }
  await req.db.query("UPDATE users SET trade_idea_max_price = $1 WHERE id = $2", [tradeIdeaMaxPrice, req.session.userId]);
  res.json({ ok: true, tradeIdeaMaxPrice });
});

// Optional personal financial profile — powers the self-directed
// Retirement Outlook below. All fields nullable/optional.
router.get("/profile", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  const { rows } = await req.db.query(
    "SELECT date_of_birth, retirement_target_age, monthly_expenses, monthly_contribution FROM users WHERE id = $1",
    [req.session.userId]
  );
  res.json(rows[0] || {});
});

router.patch("/profile", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  const fields = ["date_of_birth", "retirement_target_age", "monthly_expenses", "monthly_contribution"];
  const updates = fields.filter((f) => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: "No fields to update." });
  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(", ");
  const values = updates.map((f) => req.body[f]);
  await req.db.query(`UPDATE users SET ${setClause} WHERE id = $${updates.length + 1}`, [...values, req.session.userId]);
  res.json({ ok: true });
});

// Deterministic (no AI call) — real synced holdings value + the profile
// above, run through the same simplified projection math households get.
// Returns hasProfile:false rather than an error when there isn't enough
// data yet; the frontend's empty state handles prompting for it.
router.get("/retirement-outlook", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  const [{ rows: profileRows }, { rows: holdings }] = await Promise.all([
    req.db.query(
      "SELECT date_of_birth, retirement_target_age, monthly_expenses, monthly_contribution FROM users WHERE id = $1",
      [req.session.userId]
    ),
    req.db.query("SELECT market_value FROM holdings WHERE user_id = $1", [req.session.userId]),
  ]);
  const outlook = personalRetirementOutlook(holdings, profileRows[0]);
  res.json(outlook ? { hasProfile: true, ...outlook } : { hasProfile: false });
});

// Not covered by the app-wide requireLogin wrapper (server.js applies that
// per-router, and /auth has to stay reachable while logged out for
// login/signup) — so this route checks the session itself.
router.post("/delete-account", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Enter your password to confirm." });

  const userId = req.session.userId;
  const { rows } = await req.db.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  // Stop any live billing before the record of it (subscriptions row,
  // holding stripe_customer_id) disappears in the cascade below — otherwise
  // the subscription keeps running on Stripe's side with no way back in to
  // stop it.
  const { rows: subRows } = await req.db.query(
    "SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1",
    [userId]
  );
  if (subRows[0]?.stripe_subscription_id) {
    await cancelSubscriptionImmediately(subRows[0].stripe_subscription_id);
  }

  // Revoke each Plaid Item on Plaid's side too — otherwise the connection
  // stays live (and billed per Item) after our copy of the token is gone.
  // Best-effort: an already-revoked or invalid Item shouldn't block deletion.
  const { rows: plaidRows } = await req.db.query(
    "SELECT access_token FROM plaid_connections WHERE user_id = $1",
    [userId]
  );
  for (const conn of plaidRows) {
    try {
      await removeItem(decryptToken(conn.access_token));
    } catch (e) {
      console.error("Plaid item/remove failed during account deletion:", e.message);
    }
  }

  // Every user-owned table has ON DELETE CASCADE back to users (see
  // db/schema.sql) — holdings, recommendations, opportunities, chat
  // history, connections, households and everything nested under them, all
  // go in one statement rather than needing to be listed here by hand.
  await req.db.query("DELETE FROM users WHERE id = $1", [userId]);
  req.session.destroy(() => res.json({ ok: true }));
});

export default router;
