// Monthly subscription billing. Payment details are entered on Stripe's own
// hosted Checkout/Portal pages — this app never sees or handles a card
// number, matching the same "never touch the sensitive thing directly"
// pattern as Schwab/Plaid token handling.
import Stripe from "stripe";

let _stripe = null;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Billing isn't configured yet (STRIPE_SECRET_KEY missing).");
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// Fast, local check for gating routes — reads the cached status (kept
// fresh by the webhook, and resynced whenever the user visits Billing)
// rather than calling Stripe's API on every gated request.
export async function hasActiveSubscription(db, userId) {
  const { rows } = await db.query("SELECT status FROM subscriptions WHERE user_id = $1", [userId]);
  return rows[0] && (rows[0].status === "active" || rows[0].status === "trialing");
}

// Returns this user's Stripe customer id, creating both the Stripe Customer
// and the local subscriptions row on first use.
export async function getOrCreateCustomerId(db, userId, email) {
  const { rows } = await db.query("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [userId]);
  if (rows[0]) return rows[0].stripe_customer_id;

  const customer = await stripe().customers.create({ email, metadata: { app_user_id: String(userId) } });
  await db.query(
    "INSERT INTO subscriptions (user_id, stripe_customer_id, status) VALUES ($1, $2, 'none')",
    [userId, customer.id]
  );
  return customer.id;
}

export async function createCheckoutSession(customerId, successUrl, cancelUrl) {
  return stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

export async function createPortalSession(customerId, returnUrl) {
  return stripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

// Reads current status directly from Stripe and writes it to our row —
// called on-demand from GET /billing/status, so subscription state stays
// accurate even if the webhook isn't reliably configured yet. The webhook
// (routes/billing.js) does the same write, just triggered by Stripe instead
// of by the user loading a page.
export async function syncSubscriptionStatus(db, userId) {
  const { rows } = await db.query("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [userId]);
  if (!rows[0]) return { status: "none" };

  const subs = await stripe().subscriptions.list({ customer: rows[0].stripe_customer_id, limit: 1 });
  const sub = subs.data[0];
  const status = sub ? sub.status : "none";
  const currentPeriodEnd = periodEndFromSubscription(sub);

  await db.query(
    "UPDATE subscriptions SET stripe_subscription_id = $1, status = $2, current_period_end = $3, updated_at = now() WHERE user_id = $4",
    [sub?.id || null, status, currentPeriodEnd, userId]
  );
  return { status, currentPeriodEnd };
}

// Recent Stripe API versions moved current_period_end from the top-level
// subscription object down to each subscription item — it's no longer
// reliably present on the subscription itself. Check both, item first.
function periodEndFromSubscription(sub) {
  if (!sub) return null;
  const seconds = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return seconds ? new Date(seconds * 1000) : null;
}

export async function updateFromWebhookEvent(db, event) {
  const sub = event.data.object;
  if (!sub.customer) return;
  const status = sub.status || "none";
  const currentPeriodEnd = periodEndFromSubscription(sub);
  await db.query(
    "UPDATE subscriptions SET stripe_subscription_id = $1, status = $2, current_period_end = $3, updated_at = now() WHERE stripe_customer_id = $4",
    [sub.id, status, currentPeriodEnd, sub.customer]
  );
}

export function constructWebhookEvent(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET not configured.");
  return stripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}
