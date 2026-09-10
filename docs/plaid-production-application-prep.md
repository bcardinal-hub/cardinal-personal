# Plaid Production Access — Application Prep

Plaid's Production application is submitted through your own Plaid dashboard (dashboard.plaid.com → your app → request Production access) — I can't submit it for you since it requires your business verification details and dashboard login, but here's every piece of written content pre-drafted so the actual submission is copy-paste.

## Before you submit: one hard blocker

Plaid's application requires a **live, working Privacy Policy URL**. Cardinal Personal doesn't have one published yet — this is the same gap flagged in the [compliance research memo](./compliance-research-memo.md). **A Privacy Policy needs to exist at a real URL (e.g., `cardinal-personal.onrender.com/privacy.html`) before you submit this application**, or Plaid will reject it outright. Ideally this comes out of the same attorney engagement as the ToS — ask me to draft a starting version if you want something in place sooner, but flag it as attorney-reviewed-pending, same as the ToS.

## Application field content (copy-paste ready)

**App name:** Cardinal Personal

**App description / use case** (Plaid usually asks something like "describe what your app does and how you use Plaid data"):

> Cardinal Personal is a subscription financial research tool for individual consumers managing their own investments. Users connect their own bank or brokerage accounts via Plaid to sync their real investment holdings (via the Investments product). The app never initiates a transaction, transfer, or trade of any kind — it is strictly read-only. Once synced, an AI-assisted research layer analyzes the user's own holdings (fundamentals, risk, tax framing, diversification) and presents findings for the user to review; every actual investment decision is made and executed by the user themselves, in their own brokerage. Cardinal Personal never has write access, never stores Plaid login credentials (Plaid returns only a token, never the user's actual bank credentials), and access tokens are encrypted at rest (AES-256-GCM) in our database.

**Plaid products used:** Investments (holdings/positions data). Not requesting Auth, Transactions, Liabilities, or Payments/transfer products — this app has no need for them given its read-only, holdings-analysis-only scope.

**Estimated end users:** [Fill in your honest current estimate — Plaid asks this to gauge scale; a small/early number is completely fine and expected for a new Production application, don't inflate it.]

**How users connect (end user flow description):**

> A user signs up for a Cardinal Personal account (separate from their bank credentials), then clicks "Connect bank or brokerage," which launches Plaid Link. They select their institution and authenticate directly with Plaid/their institution — Cardinal Personal never sees or stores their actual login credentials, only the resulting access token. After a successful connection, the user's investment holdings sync into their private dashboard for analysis.

**Data retention / deletion practices** (Plaid will ask how long you keep data and how a user can have it deleted):

> Synced holdings data is retained only as long as the user's account remains connected. Users can self-serve permanently delete their entire account at any time from within the app (Billing → Danger Zone), which immediately removes all Plaid/Schwab access tokens, synced holdings, and related data from our database — no support request required.

**Security practices summary** (Plaid's security questionnaire will ask about this in more depth, but for the initial application description):

> - Access tokens encrypted at rest (AES-256-GCM), decrypted only server-side, never exposed to the browser
> - All traffic over HTTPS
> - Passwords hashed with bcrypt, never stored in plaintext
> - Sessions stored server-side (Postgres-backed), not in client-readable cookies
> - No route in the application can initiate a transfer, trade, or write operation of any kind

## What Plaid's actual review process looks like

- Plaid's Production review typically takes anywhere from a few days to a few weeks, and can include follow-up questions about your security practices, data handling, and business model.
- They may ask for a walkthrough or screen recording of your actual Plaid Link integration in Sandbox mode (which is already fully working — this session verified it live).
- Until Production is approved, `PLAID_ENV` stays `sandbox` and only Plaid's test institutions/credentials work — this is expected and not a bug.
- Once approved, flip `PLAID_ENV=production` on Render and swap in your **Production** `PLAID_CLIENT_ID`/`PLAID_SECRET` pair (Plaid issues a separate key pair per environment — your current sandbox keys will not work in production).

## What I'd need from you to help further

Nothing sensitive yet — but once you have a Privacy Policy URL live and have submitted the application, if Plaid comes back with specific follow-up questions about the technical implementation (not the business/legal ones), paste them here and I can help draft accurate, specific answers grounded in what the code actually does.
