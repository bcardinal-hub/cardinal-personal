import express from "express";
import {
  getOrCreateCustomerId,
  createCheckoutSession,
  createPortalSession,
  syncSubscriptionStatus,
  updateFromWebhookEvent,
  constructWebhookEvent,
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
    const { rows } = await req.db.query("SELECT email FROM users WHERE id = $1", [req.session.userId]);
    const customerId = await getOrCreateCustomerId(req.db, req.session.userId, rows[0].email);
    const origin = `${req.protocol}://${req.get("host")}`;
    const session = await createCheckoutSession(
      customerId,
      `${origin}/dashboard.html?billing=success#billing`,
      `${origin}/dashboard.html?billing=cancelled#billing`
    );
    res.json({ url: session.url });
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
