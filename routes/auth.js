import express from "express";
import bcrypt from "bcryptjs";

const router = express.Router();

const SALT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : raw;
}

router.post("/signup", async (req, res) => {
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

router.post("/login", async (req, res) => {
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

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

export default router;
