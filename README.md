# Cardinal Finance AI — the research desk for people who manage their own money

A subscription ($29/mo, 7-day free trial) self-directed financial copilot: connect
your real accounts (any bank/brokerage via Plaid, or Schwab directly), and a
10-role research desk — modeled on a real advisory firm's org chart, not a
single chatbot — analyzes your actual holdings. **This app never places a
trade.** Every order is placed by the person themselves, in their own broker.
It's a research and decision-support tool, positioned as an alternative to
paying a human financial advisor for routine portfolio oversight — not a
replacement for licensed investment advice.

Live at [cardinal-personal.onrender.com](https://cardinal-personal.onrender.com).

## The desk

Ten specialist roles, each its own Claude call with its own lens (see
`lib/claude.js` `AGENTS`, `lib/tradeIdeas.js`, `lib/optionsIdeas.js`):

| Role | What it does |
|---|---|
| Head of Equity Research | Fundamentals — earnings, margins, valuation |
| News & Catalyst Desk | Real news flow on what you hold |
| Sentiment Desk | Whether sentiment looks stretched |
| Technical Strategist | Price action vs. range/benchmarks |
| Chief Portfolio Strategist | Concentration, diversification, cash |
| Chief Risk Officer | Correlated bets, position-size red flags |
| Tax Strategist | Loss harvesting, wash-sale, holding-period timing |
| Trade Ideas Desk | Scans holdings + live market for setups worth a look |
| Options Strategist | Strategy-level options ideas (no fabricated strikes/premiums) |
| Market Strategist | Daily market-wide tape roundup |

Every agent is instructed never to invent a figure it doesn't have — search-
enabled agents ground claims in real web search results; reasoning-only
agents (Portfolio Strategist, Risk, Tax) work strictly from the synced
position list. The AI Assistant chat is the "concierge" for the desk: it
reads the last 10 recommendations from any specialist so it can build on
what the team already found instead of contradicting it.

Recommendations and Opportunities are tagged `source: 'deterministic'` (pure
math — tax-loss detection, RMD checks, insurance gaps) vs `source: 'ai'`
(a model's judgment call) everywhere in the schema and UI — the two are
never blurred together.

## Product surfaces

- **Positions** — synced holdings, allocation, P/L (read-only)
- **Terminal** — dark, trading-floor-style live view: scrolling ticker tape,
  live watchlist, real news wire, your book, and the desk's live findings
  (Desk Signals), all in one screen
- **Market** — live quotes (Finnhub) + AI daily snapshot
- **News** — real headlines, general + per-holding, never AI-paraphrased
- **AI Assistant** — chat, grounded in your holdings + the desk's findings
- **Recommendations** — the 7 analysis agents' output, with a "meet the
  desk" roster panel
- **Opportunities** — deterministic checks + AI trade ideas + a separate,
  explicitly-gated options-ideas scan
- **Billing** — Stripe Checkout/Portal, self-serve subscribe/cancel
- **Clients** (Advisor section) — optional household/multi-client management
  for someone using this as a practice tool rather than for themselves

## Architecture

```
Browser (PWA — installable, public/*.html + manifest.json + sw.js)
   │
   ▼
Node/Express (server.js, ESM, express-async-errors so no route can crash
   │            the process; global error handler + unhandledRejection
   │            catch as defense-in-depth)
   │  Postgres-backed sessions (connect-pg-simple, 30-day rolling)
   │  AES-256-GCM at rest for Schwab/Plaid tokens (lib/crypto.js)
   ▼
Postgres (Neon) — users, holdings, recommendations, opportunities,
   │               subscriptions, chat_messages, audit_log, households/
   │               clients/accounts (advisor side)
   ▼
External APIs, all server-side only (keys never reach the browser):
   - Anthropic (claude-sonnet-5, + web_search tool) — the desk
   - Plaid — primary account-linking path, any bank/brokerage
   - Schwab Trader API — direct OAuth, Individual-tier (own account only)
   - Finnhub — real quotes + news, never LLM-generated
   - Stripe — Checkout, Billing Portal, subscription webhooks
```

Deploys via GitHub → Render (auto-deploy on push to `main`). Render's edge
proxy terminates HTTPS in production (`trust proxy` + `NODE_ENV=production`
detection in `server.js`); locally, a self-signed cert under `certs/`
(gitignored) serves HTTPS because Schwab's OAuth callback requires it even
on localhost.

## Cost controls

Every AI-calling route that a user can trigger by hand (`/analysis/run`,
`/opportunities/scan/*`, `/market/:kind/refresh`) is behind both
`requireSubscription` (`lib/paywall.js`) and a DB-backed cooldown
(`lib/cooldown.js`, 5–10 min depending on the route) — a flat-rate monthly
product can't have an unbounded per-click Claude spend. The market snapshot
cooldown matters more than the per-user ones: those snapshots are shared
instance-wide, so one person mashing Refresh would spend every subscriber's
shared budget.

## Local setup

1. `npm install`
2. Generate a local self-signed HTTPS cert (Schwab's OAuth callback rejects
   plain `http://`, even for localhost):
   ```
   mkdir -p certs
   openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 825 -nodes \
     -subj "/CN=127.0.0.1" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
   ```
   `server.js` auto-detects `certs/*.pem` and serves HTTPS when present —
   click through the one-time browser "not secure" warning.
3. Copy `.env.example` to `.env` and fill in every key: Plaid (sandbox is
   free, instant), Schwab (Individual-tier developer app — free, no review,
   only ever authorizes the account that registered it), Anthropic, Finnhub,
   Stripe (test mode), a free Postgres instance (Neon), and generate
   `SESSION_SECRET` / `TOKEN_ENCRYPTION_KEY` (see the comment in
   `.env.example`).
4. Run `db/schema.sql` against your Postgres instance.
5. `npm run dev` → `https://127.0.0.1:3000`.

## Schwab: Individual vs. Commercial access

Schwab's Trader API has two tiers. **Individual** (free, no review) only
ever authorizes the Schwab account of whoever registered the developer app
— which is why Plaid, not Schwab, is the primary connection path for real
subscribers (anyone can link any bank/brokerage through it). Schwab stays
available as a secondary option for someone who registers their own
Individual developer app. **Commercial** access (Schwab's own review) would
only be needed to let *other people* connect *their* Schwab accounts
directly through this app's own Schwab credentials — not currently pursued.

## The line this product doesn't cross

No route places, modifies, sizes, or cancels an order — not for equities,
not for options. Every agent's system prompt explicitly forbids implying a
trade should happen automatically. The person reviews every recommendation
and executes every order themselves, in their own broker. This is deliberate
product design, not a missing feature.

**Not yet done, flagged deliberately:** actual legal/compliance review
before this ever takes real (non-test-mode) payment from the public, given
that charging strangers for portfolio analysis touches Investment Adviser
Act considerations that need a real look before broad marketing.
