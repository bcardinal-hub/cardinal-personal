import express from "express";
import { runAgent, AGENTS } from "../lib/claude.js";

const router = express.Router();

// Runs all agents over the user's currently-synced holdings and stores each
// result as a pending_review recommendation — nothing here auto-approves
// or acts on anything.
router.post("/run", async (req, res) => {
  const { rows: holdings } = await req.db.query("SELECT * FROM holdings WHERE user_id = $1", [req.session.userId]);
  if (holdings.length === 0) {
    return res.status(400).json({ error: "No holdings on file yet — run /schwab/sync first." });
  }

  // Agents are independent of each other (each is its own Claude call, some
  // with their own web search) — run them concurrently instead of one at a
  // time so "Run analysis" takes as long as the slowest agent, not the sum
  // of all five.
  const results = await Promise.all(
    AGENTS.map(async (agent) => {
      try {
        const result = await runAgent(agent, holdings);
        const inserted = await req.db.query(
          `INSERT INTO recommendations (user_id, agent, content_type, summary, confidence, status)
           VALUES ($1, $2, $3, $4, $5, 'pending_review') RETURNING *`,
          [req.session.userId, agent.label, result.content_type, result.summary, result.confidence]
        );
        return inserted.rows[0];
      } catch (e) {
        return { agent: agent.label, error: e.message };
      }
    })
  );

  await req.db.query("INSERT INTO audit_log (user_id, actor, action) VALUES ($1, $2, $3)", [
    req.session.userId,
    "System",
    `Ran analysis across ${AGENTS.length} agents on ${holdings.length} holdings.`,
  ]);

  res.json({ ok: true, results });
});

// Advisor-of-yourself review actions — same shape as the Cardinal approval
// queue, just scoped to one person's own recommendations.
router.post("/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (!["approved", "edited", "rejected"].includes(action)) {
    return res.status(400).json({ error: "Action must be approved, edited, or rejected." });
  }
  await req.db.query("UPDATE recommendations SET status = $1 WHERE id = $2 AND user_id = $3", [
    action,
    id,
    req.session.userId,
  ]);
  await req.db.query("INSERT INTO audit_log (user_id, actor, action) VALUES ($1, $2, $3)", [
    req.session.userId,
    "You",
    `${action} recommendation #${id}`,
  ]);
  res.json({ ok: true });
});

router.get("/", async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT * FROM recommendations WHERE user_id = $1 ORDER BY created_at DESC",
    [req.session.userId]
  );
  res.json(rows);
});

export default router;
