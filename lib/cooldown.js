// Guards the routes that spend real Claude API budget (and, for options/
// trade-idea scans, real web-search budget) against being mashed — by a
// bored subscriber double-clicking, or a script. Nothing here is about
// abuse in a security sense; it's a unit-economics guard, since this is a
// flat $29/mo product and every "Run analysis" click is ~7 Claude calls.
//
// Deliberately DB-backed (reads the same timestamp the route just wrote)
// rather than in-memory — survives a restart/redeploy, and works correctly
// even if this ever runs across more than one instance.
export function cooldown({ minutes, label, query }) {
  return async (req, res, next) => {
    try {
      const { rows } = await query(req);
      const last = rows[0]?.created_at;
      if (last) {
        const elapsedMs = Date.now() - new Date(last).getTime();
        const waitMs = minutes * 60 * 1000 - elapsedMs;
        if (waitMs > 0) {
          const waitMin = Math.max(1, Math.ceil(waitMs / 60000));
          return res.status(429).json({
            error: `${label} was run recently — try again in about ${waitMin} minute${waitMin === 1 ? "" : "s"}.`,
          });
        }
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
