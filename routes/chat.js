import express from "express";
import { runChatTurn } from "../lib/claude.js";

const router = express.Router();

router.get("/chat", async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT role, content, created_at FROM chat_messages WHERE user_id = $1 ORDER BY created_at ASC",
    [req.session.userId]
  );
  res.json(rows);
});

router.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "Message required." });

  try {
    await req.db.query("INSERT INTO chat_messages (user_id, role, content) VALUES ($1, 'user', $2)", [
      req.session.userId,
      message,
    ]);

    const [{ rows: history }, { rows: holdings }] = await Promise.all([
      req.db.query("SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY created_at ASC", [
        req.session.userId,
      ]),
      req.db.query("SELECT * FROM holdings WHERE user_id = $1", [req.session.userId]),
    ]);

    const reply = await runChatTurn(history, holdings);

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
