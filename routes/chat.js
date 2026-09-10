import express from "express";
import { runChatTurn } from "../lib/claude.js";
import { requireSubscription } from "../lib/paywall.js";

const router = express.Router();

router.get("/chat", async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT role, content, created_at FROM chat_messages WHERE user_id = $1 ORDER BY created_at ASC",
    [req.session.userId]
  );
  res.json(rows);
});

router.post("/chat", requireSubscription, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "Message required." });

  try {
    await req.db.query("INSERT INTO chat_messages (user_id, role, content) VALUES ($1, 'user', $2)", [
      req.session.userId,
      message,
    ]);

    const [{ rows: history }, { rows: holdings }, { rows: recommendations }, { rows: opportunities }] = await Promise.all([
      req.db.query("SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY created_at ASC", [
        req.session.userId,
      ]),
      req.db.query("SELECT * FROM holdings WHERE user_id = $1", [req.session.userId]),
      // Recent desk findings — lets the assistant reference what the other
      // specialists already flagged instead of re-deriving it from scratch
      // or contradicting them.
      req.db.query(
        "SELECT agent, summary FROM recommendations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10",
        [req.session.userId]
      ),
      // Recent AI idea callouts (Trade Ideas/Options/Day Trading) plus
      // their real graded outcome if one exists yet — so someone can ask
      // "what happened with that AAPL day-trading idea" and the assistant
      // actually knows, instead of only knowing about the 7-agent desk.
      req.db.query(
        `SELECT category, explanation, price_at_callout, price_at_review, pct_change, reviewed_at, created_at
         FROM opportunities WHERE user_id = $1 AND source = 'ai' ORDER BY created_at DESC LIMIT 10`,
        [req.session.userId]
      ),
    ]);

    const reply = await runChatTurn(history, holdings, recommendations, opportunities);

    const { rows: inserted } = await req.db.query(
      "INSERT INTO chat_messages (user_id, role, content) VALUES ($1, 'assistant', $2) RETURNING role, content, created_at",
      [req.session.userId, reply]
    );

    res.json({ ok: true, reply: inserted[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
