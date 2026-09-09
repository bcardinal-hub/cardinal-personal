import express from "express";
import { runMarketSnapshot } from "../lib/claude.js";

const router = express.Router();
const VALID_KINDS = new Set(["overview", "news"]);

function checkKind(req, res, next) {
  if (!VALID_KINDS.has(req.params.kind)) return res.status(400).json({ error: "Unknown snapshot kind." });
  next();
}

// Market/news are instance-wide (not per-user) — read the latest cached
// snapshot instantly, never triggering a Claude call on page load.
router.get("/:kind", checkKind, async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT summary, created_at FROM market_snapshots WHERE kind = $1 ORDER BY created_at DESC LIMIT 1",
    [req.params.kind]
  );
  res.json({ snapshot: rows[0] || null });
});

// Explicit, human-triggered refresh — this is the only thing that spends an
// API call here, same "nothing happens silently" rule as /analysis/run.
router.post("/:kind/refresh", checkKind, async (req, res) => {
  try {
    const summary = await runMarketSnapshot(req.params.kind);
    const { rows } = await req.db.query(
      "INSERT INTO market_snapshots (kind, summary) VALUES ($1, $2) RETURNING summary, created_at",
      [req.params.kind, summary]
    );
    res.json({ snapshot: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
