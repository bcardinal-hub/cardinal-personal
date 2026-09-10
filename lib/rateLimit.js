// Simple in-memory sliding-window rate limiter for the auth endpoints
// (login, signup, forgot-password) — brute-force/spam protection. No Redis
// needed: this runs as a single instance, and an in-memory Map keyed by IP
// is genuinely sufficient at this scale. If this app ever runs multiple
// instances behind a load balancer, this would need to move to a shared
// store (Redis, or the same Postgres pool) — noted here so it isn't a
// silent gap if that happens.
const buckets = new Map();

// Periodic sweep so IPs that stop making requests don't sit in memory
// forever — the per-request check only prunes the one key it's looking at.
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of buckets) {
    if (!timestamps.some((t) => now - t < 60 * 60 * 1000)) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

export function rateLimit({ windowMs, max, label }) {
  return (req, res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const attempts = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (attempts.length >= max) {
      const retryAfterSec = Math.ceil((windowMs - (now - attempts[0])) / 1000);
      res.set("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: `Too many ${label} attempts from this connection — try again in a few minutes.` });
    }
    attempts.push(now);
    buckets.set(key, attempts);
    next();
  };
}
