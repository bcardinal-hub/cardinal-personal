import express from "express";
import {
  getOrCreateCustomerId,
  createCheckoutSession,
  createPortalSession,
  changeSubscriptionPlan,
  syncSubscriptionStatus,
  updateFromWebhookEvent,
  constructWebhookEvent,
  PLAN_PRICE_IDS,
} from "../lib/stripe.js";

const router = express.Router();

router.get("/status", async (req, res) => {
  try {
    const result = await syncSubscriptionStatus(req.db, req.session.userId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/checkout", async (req, res) => {
  try {
    const plan = req.body?.plan === "pro" ? "pro" : "standard";
    const priceId = PLAN_PRICE_IDS[plan];
    if (!priceId) return res.status(500).json({ error: `Billing isn't configured for the ${plan} plan yet.` });

    const { rows } = await req.db.query("SELECT email FROM users WHERE id = $1", [req.session.userId]);
    const customerId = await getOrCreateCustomerId(req.db, req.session.userId, rows[0].email);

    // First-time subscribers get a 7-day free trial; someone re-subscribing
    // after a previous cancellation doesn't get a second one.
    const { rows: subRows } = await req.db.query("SELECT status FROM subscriptions WHERE user_id = $1", [req.session.userId]);
    const trialDays = subRows[0]?.status === "none" ? 7 : 0;

    const origin = `${req.protocol}://${req.get("host")}`;
    const session = await createCheckoutSession(
      customerId,
      `${origin}/dashboard.html?billing=success#billing`,
      `${origin}/dashboard.html?billing=cancelled#billing`,
      trialDays,
      priceId
    );
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Switches an already-active subscription between Standard and Pro in
// place — no new Checkout session, no re-entering a card. Stripe prorates
// the difference automatically.
router.post("/change-plan", async (req, res) => {
  try {
    const plan = req.body?.plan === "pro" ? "pro" : "standard";
    const priceId = PLAN_PRICE_IDS[plan];
    if (!priceId) return res.status(500).json({ error: `Billing isn't configured for the ${plan} plan yet.` });

    const { rows } = await req.db.query(
      "SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1",
      [req.session.userId]
    );
    const sub = rows[0];
    if (!sub?.stripe_subscription_id || (sub.status !== "active" && sub.status !== "trialing")) {
      return res.status(400).json({ error: "No active subscription to change — subscribe first." });
    }

    await changeSubscriptionPlan(sub.stripe_subscription_id, priceId);
    // Reflect the change immediately rather than waiting on the webhook —
    // same "resync on the action that just happened" pattern as checkout.
    const result = await syncSubscriptionStatus(req.db, req.session.userId);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/portal", async (req, res) => {
  try {
    const { rows } = await req.db.query("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [req.session.userId]);
    if (!rows[0]) return res.status(400).json({ error: "No billing account yet — subscribe first." });
    const origin = `${req.protocol}://${req.get("host")}`;
    const session = await createPortalSession(rows[0].stripe_customer_id, `${origin}/dashboard.html#billing`);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

// Stripe webhook needs the RAW request body to verify the signature, which
// must be registered BEFORE express.json() parses it — see server.js for
// where this raw-body route is mounted ahead of the JSON body parser.
export async function webhookHandler(req, res) {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers["stripe-signature"]);
  } catch (e) {
    return res.status(400).send(`Webhook signature verification failed: ${e.message}`);
  }

  if (event.type.startsWith("customer.subscription.")) {
    await updateFromWebhookEvent(req.db, event);
  }
  res.json({ received: true });
}
