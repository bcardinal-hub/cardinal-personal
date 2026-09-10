// Monthly subscription billing. Payment details are entered on Stripe's own
// hosted Checkout/Portal pages — this app never sees or handles a card
// number, matching the same "never touch the sensitive thing directly"
// pattern as Schwab/Plaid token handling.
//
// Two plans, same product: Standard ($29/mo) and Pro ($40/mo). Pro is
// additive — everything Standard has, plus the two highest-risk idea
// categories (Options Strategist, Day Trading Desk), gated by
// requirePro in lib/paywall.js rather than requireSubscription.
import Stripe from "stripe";

let _stripe = null;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Billing isn't configured yet (STRIPE_SECRET_KEY missing).");
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

export const PLAN_PRICE_IDS = {
  standard: process.env.STRIPE_PRICE_ID,
  pro: process.env.STRIPE_PRICE_ID_PRO,
};

// Derives plan tier from the actual Stripe price id on the subscription —
// deliberately not a separate stored "plan" column, so it can never drift
// out of sync with what Stripe is really billing. Falls back to
// 'standard' for an unrecognized price rather than silently granting Pro.
export function planForPriceId(priceId) {
  if (priceId && priceId === PLAN_PRICE_IDS.pro) return "pro";
  return "standard";
}

function priceIdFromSubscription(sub) {
  return sub?.items?.data?.[0]?.price?.id || null;
}

// Fast, local check for gating routes — reads the cached status (kept
// fresh by the webhook, and resynced whenever the user visits Billing)
// rather than calling Stripe's API on every gated request.
export async function hasActiveSubscription(db, userId) {
  const { rows } = await db.query("SELECT status FROM subscriptions WHERE user_id = $1", [userId]);
  return rows[0] && (rows[0].status === "active" || rows[0].status === "trialing");
}

// Same, but additionally requires the Pro price — used for Options and Day
// Trading, the two features that ship only on the higher tier.
export async function hasProSubscription(db, userId) {
  const { rows } = await db.query("SELECT status, stripe_price_id FROM subscriptions WHERE user_id = $1", [userId]);
  const row = rows[0];
  if (!row || (row.status !== "active" && row.status !== "trialing")) return false;
  return planForPriceId(row.stripe_price_id) === "pro";
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

export async function createCheckoutSession(customerId, successUrl, cancelUrl, trialDays = 0, priceId) {
  const price = priceId || PLAN_PRICE_IDS.standard;
  return stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(trialDays > 0 ? { subscription_data: { trial_period_days: trialDays } } : {}),
  });
}

export async function createPortalSession(customerId, returnUrl) {
  return stripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

// Switches an already-active subscription to a different price (Standard
// <-> Pro) in place — no new Checkout session, no re-entering a card.
// Prorates the difference by default, same as Stripe's own portal would.
export async function changeSubscriptionPlan(subscriptionId, newPriceId) {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const itemId = sub.items?.data?.[0]?.id;
  if (!itemId) throw new Error("Could not find the subscription's billing item to update.");
  return stripe().subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: "create_prorations",
  });
}

// Immediate cancellation (not "at period end") — used only when someone is
// deleting their whole account. Once the account row is gone there's no
// portal left for them to manage billing from, so leaving a subscription
// running would silently keep charging a card with no way back in to stop
// it. Tolerates the subscription already being gone/canceled on Stripe's
// side (e.g. it never actually started) rather than blocking deletion.
export async function cancelSubscriptionImmediately(subscriptionId) {
  if (!subscriptionId) return;
  try {
    await stripe().subscriptions.cancel(subscriptionId);
  } catch (e) {
    if (e?.code !== "resource_missing") throw e;
  }
}

// Reads current status directly from Stripe and writes it to our row —
// called on-demand from GET /billing/status, so subscription state stays
// accurate even if the webhook isn't reliably configured yet. The webhook
// (routes/billing.js) does the same write, just triggered by Stripe instead
// of by the user loading a page.
export async function syncSubscriptionStatus(db, userId) {
  const { rows } = await db.query("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [userId]);
  if (!rows[0]) return { status: "none", plan: null };

  const subs = await stripe().subscriptions.list({ customer: rows[0].stripe_customer_id, limit: 1 });
  const sub = subs.data[0];
  const status = sub ? sub.status : "none";
  const currentPeriodEnd = periodEndFromSubscription(sub);
  const priceId = priceIdFromSubscription(sub);

  await db.query(
    "UPDATE subscriptions SET stripe_subscription_id = $1, stripe_price_id = $2, status = $3, current_period_end = $4, updated_at = now() WHERE user_id = $5",
    [sub?.id || null, priceId, status, currentPeriodEnd, userId]
  );
  return { status, currentPeriodEnd, plan: sub ? planForPriceId(priceId) : null };
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
  const priceId = priceIdFromSubscription(sub);
  await db.query(
    "UPDATE subscriptions SET stripe_subscription_id = $1, stripe_price_id = $2, status = $3, current_period_end = $4, updated_at = now() WHERE stripe_customer_id = $5",
    [sub.id, priceId, status, currentPeriodEnd, sub.customer]
  );
}

export function constructWebhookEvent(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET not configured.");
  return stripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}
