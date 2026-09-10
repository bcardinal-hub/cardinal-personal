import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { cancelSubscriptionImmediately } from "../lib/stripe.js";
import { sendPasswordResetEmail } from "../lib/email.js";
import { rateLimit } from "../lib/rateLimit.js";

const router = express.Router();

// Brute-force/spam protection, per IP. Login is the tightest (credential
// guessing is the real risk); signup and forgot-password are looser but
// still capped (mass account creation, email-bombing an address).
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, label: "login" });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, label: "signup" });
const forgotPasswordLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, label: "password reset" });

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

router.post("/signup", signupLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "That doesn't look like a valid email." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await req.db.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, passwordHash]
    );
    req.session.userId = result.rows[0].id;
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: "Could not create account — email may already be in use." });
  }
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
  req.session.userId = user.id;
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
  // Log them straight in — they just proved account ownership via the
  // emailed link, no reason to make them type the new password twice.
  req.session.userId = user.id;
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
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

  // Every user-owned table has ON DELETE CASCADE back to users (see
  // db/schema.sql) — holdings, recommendations, opportunities, chat
  // history, connections, households and everything nested under them, all
  // go in one statement rather than needing to be listed here by hand.
  await req.db.query("DELETE FROM users WHERE id = $1", [userId]);
  req.session.destroy(() => res.json({ ok: true }));
});

export default router;
