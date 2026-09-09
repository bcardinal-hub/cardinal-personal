// Gates the routes that actually cost money to run (Claude calls) behind an
// active subscription — applied per-route, not per-router, since most
// routers mix free reads/account-sync with paid AI actions. Reading cached
// data, connecting an account, and syncing holdings all stay free; running
// analysis, scanning for opportunities, and chatting with the AI Assistant
// require an active subscription.
import { hasActiveSubscription } from "./stripe.js";

export async function requireSubscription(req, res, next) {
  try {
    const active = await hasActiveSubscription(req.db, req.session.userId);
    if (!active) {
      return res.status(402).json({ error: "This requires an active Cardinal Personal subscription. Visit Billing to subscribe." });
    }
    next();
  } catch (e) {
    next(e);
  }
}
