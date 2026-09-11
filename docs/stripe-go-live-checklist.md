# Stripe Go-Live Checklist

Everything needed to take Cardinal Finance AI from Stripe **test mode** to actually charging real money.

## Current state (verified against the Stripe API)

| Thing | Status |
|---|---|
| Stripe account | `acct_1UDrg52NjSKK0fAQ` |
| Mode of keys on Render | **test** (`sk_test_…`) |
| `details_submitted` | **false** — business verification has not been started |
| `charges_enabled` | **false** |
| `payouts_enabled` | **false** |
| Account display name | **not set** (this is why it still reads oddly on checkout) |
| Product | "Cardinal Finance AI" ✅ (test mode) |
| Price — Standard | `price_1UDrl22NjSKK0fAQ54yDdNXT` — $29/mo (test mode) |
| Price — Pro | `price_1UE9WH2NjSKK0fAQShus9E5O` — $40/mo (test mode) |

## ⚠️ The gotcha that will bite you

**Test mode and live mode are completely separate object universes.** Your product and both prices exist *only in test mode*. They do **not** carry over when you flip the switch.

If you swap in live API keys without recreating them, every checkout will fail with "no such price" — because `price_1UDrl2…` does not exist in live mode. Same for the webhook: the signing secret you set up for the test endpoint is not valid for a live endpoint.

So going live is 4 steps, not 1.

---

## Step 1 — Verify your business

**Where:** dashboard.stripe.com → the **"Activate payments"** / "Complete your profile" prompt on the home screen (or Settings → Business settings → Account status).

**Have ready:**
- Legal name, date of birth, home address
- **SSN** (full, or last 4 + verification) — since there's no LLC yet, you're verifying as an **individual / sole proprietor**, not a company
- A **bank account + routing number** for payouts (your personal account is fine for a sole proprietor)
- Your business website: `https://cardinal-personal.onrender.com`
- Product description — something like: *"Subscription financial research software. Users connect their own investment accounts read-only and receive AI-assisted analysis of their own holdings. No trades are placed and no funds are handled."*
- Expected monthly volume (an honest small estimate is fine and expected)

**I can't do this step and won't ask you to share any of it with me** — SSN, bank details, and identity documents go directly into Stripe's dashboard and nowhere else. Never paste them into this chat.

**Worth knowing before you click:** as a sole proprietor, this is your personal SSN and personal liability behind the business. That's a normal way to start and is consistent with deferring the LLC — just go in knowing that's what you're signing, and that forming the LLC later means redoing this verification under the new entity.

Verification is usually near-instant, sometimes a day or two if Stripe asks for a document.

## Step 2 — Set the public-facing name

**Where:** Settings → Business settings → **Public details**

Set the public business name to **Cardinal Finance AI**. This is what shows on the Checkout page, on receipts, and on your customers' card statements. It's currently unset, which is why checkout looks generic.

Also set the **statement descriptor** (what literally appears on a card statement) — something like `CARDINALFINANCE`. Short, recognizable, so nobody disputes the charge because they didn't recognize it.

## Step 3 — Recreate the product and prices in LIVE mode

**Where:** flip the **"Test mode" toggle OFF** (top-right of the dashboard), then Product catalog → Add product.

Create one product with two prices, matching test mode exactly:

- **Product name:** Cardinal Finance AI
- **Price 1:** $29.00 USD / month, recurring → this becomes your **Standard** tier
- **Price 2:** $40.00 USD / month, recurring → this becomes your **Pro** tier

Add both prices to the *same* product (use "Add another price"), not two separate products — the in-place plan switching in [lib/stripe.js](../lib/stripe.js) works by swapping the price on one subscription.

**Copy both live price IDs** (they start `price_…` and will be different from the test ones). You need them in Step 5.

## Step 4 — Create the LIVE webhook endpoint

Still in live mode: Developers → Webhooks → **Add endpoint**. Same as the one you set up in test mode:

- **Endpoint URL:** `https://cardinal-personal.onrender.com/billing/webhook`
- **Events:** `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` — the handler in [routes/billing.js](../routes/billing.js) acts only on `customer.subscription.*`, so nothing else is needed

Then reveal and copy the **signing secret** (`whsec_…`). This is a new, different secret from the test one.

## Step 5 — Swap the four env vars on Render

Render → your service → Environment. These four, all at once:

| Variable | New value |
|---|---|
| `STRIPE_SECRET_KEY` | your **live** secret key (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_…` from Step 4 |
| `STRIPE_PRICE_ID` | the **live** $29 price ID from Step 3 |
| `STRIPE_PRICE_ID_PRO` | the **live** $40 price ID from Step 3 |

There is no publishable key to change — the app uses Stripe Checkout redirects, not Elements, so the secret key is the only Stripe credential the server needs.

Save → Render redeploys automatically (~90s).

**Paste these into Render directly. Do not paste live keys into this chat** — a live secret key can move real money, and anything in a chat transcript is stored.

## Step 6 — Verify with one real charge

Once deployed, with a **real card**:

1. Sign up a fresh account → Billing → subscribe to Standard
2. Confirm the charge lands in the Stripe dashboard (live mode) as **Succeeded**
3. Confirm the app actually unlocked — the webhook wrote the row, not just the redirect
4. **Refund yourself** from the Stripe dashboard and cancel the subscription

That last step proves the whole path end-to-end: Checkout → webhook → database → paywall. It's worth the $29 round trip to know it works before a friend hits it.

## What this does *not* resolve

Going live means taking real money for investment-related research. The open regulatory question in the [compliance research memo](./compliance-research-memo.md) — whether any of this touches investment-adviser registration — is not answered by any step above, and flipping this switch is what makes it a live question rather than a theoretical one. You've decided to move forward now and talk to an attorney later; that's your call to make, and this file isn't relitigating it. It's just on the record here so the sequencing is deliberate rather than accidental.
