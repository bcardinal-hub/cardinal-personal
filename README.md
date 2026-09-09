# Cardinal Personal — self-directed financial copilot

A personal-use version of the Cardinal Financial AI architecture: you (and, later,
friends) connect your own real Schwab account read-only, and four analyst agents
plus a planning/opportunity layer help you understand your own money. **This app
never places trades.** You always execute in Schwab yourself — this is a research
and organization tool, not a trading bot.

## The one decision to make first: Individual vs. Commercial Schwab access

Schwab's Trader API has two tiers, and this determines how you deploy:

- **Individual access** (free, no review): an app can connect *only the Schwab
  account of the person who registered the developer app*. No approval process.
- **Commercial access** (requires Schwab's review): required the moment your app
  connects *someone else's* Schwab account through your instance of it.

**Recommended path:** start with Individual access. That means each person who
wants to use this (you, then each friend) registers their own free Schwab
developer app and runs their own instance, connected only to their own account.
Same code, multiple self-contained deployments — no approval process, usable
today.

If you later want one shared login where everyone connects through a single
hosted app, that requires applying for Schwab's Commercial approval — budget
real time for that review, and keep the "AI analyzes, human places every order"
framing consistent everywhere the app is described, since that's exactly what
the review is checking for.

## Architecture

```
Browser (your UI)
   │  your own login (email/password or magic link)
   ▼
Backend (Node/Express, this scaffold)
   │  holds Schwab OAuth tokens server-side — NEVER in browser code
   │  calls Claude API server-side for analysis (API key never exposed client-side)
   ▼
Postgres (accounts, holdings, opportunities, recommendations, audit log)
   │
   ▼
Schwab Trader API (read-only account/position data)
```

## Setup

1. Generate a local self-signed HTTPS cert (Schwab's app-creation form
   rejects plain `http://` callback URLs outright, even for localhost):
   ```
   mkdir -p certs
   openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 825 -nodes \
     -subj "/CN=127.0.0.1" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
   ```
   `server.js` auto-detects `certs/*.pem` and serves HTTPS when present. Your
   browser will show a one-time "not secure" warning for the self-signed
   cert on first visit — that's expected, click through it.
2. **Schwab Developer Portal** (developer.schwab.com): create a Developer
   account, register an app, request the "Accounts and Trading Production"
   product, set an order limit of `0` (this app never places orders), and set
   the callback URL to `https://127.0.0.1:3000/schwab/callback` for local dev
   — this must exactly match `SCHWAB_CALLBACK_URL` below and the route the
   app actually serves. Approval for Individual access is typically fast.
3. Copy `.env.example` to `.env` and fill in:
   - `SCHWAB_CLIENT_ID` / `SCHWAB_CLIENT_SECRET` (from the developer portal)
   - `SCHWAB_CALLBACK_URL` (`https://127.0.0.1:3000/schwab/callback`)
   - `ANTHROPIC_API_KEY` (from console.anthropic.com — server-side only)
   - `DATABASE_URL` (a free Postgres instance from Supabase, Neon, or Railway
     works fine for personal use)
   - `SESSION_SECRET` (any long random string)
   - `TOKEN_ENCRYPTION_KEY` (32-byte hex string — see the comment in
     `.env.example` for the one-liner to generate it; this encrypts stored
     Schwab tokens at rest)
4. `npm install`
5. Run `db/schema.sql` against your Postgres instance to create tables.
6. `npm run dev` and visit `https://127.0.0.1:3000`.
7. Create an account, click "Connect Schwab," authorize with your real Schwab
   credentials (you'll be redirected to Schwab's real login — this app never
   sees your Schwab password), sync your positions, and you'll land in the
   dashboard (Positions / Market / News / AI Assistant / Recommendations).

## What's scaffolded vs. what you'll build out

This gives you the real shape: OAuth flow, token storage, a positions-sync
endpoint, and a wired-up call to the four-agent analysis pattern from the
Stock Research Copilot, adapted to analyze *your actual holdings* instead of
an arbitrary ticker. The dashboard UI itself (the part built earlier as the
Cardinal prototype) can be dropped in on top of these API routes — it's
already shaped to expect this data.

Things intentionally left as TODOs for you to fill in as you go: refresh-token
rotation on a schedule (Schwab access tokens expire in 30 minutes), per-user
encryption-at-rest for stored tokens, and the actual frontend wiring. None of
these are exotic — they're just the next concrete steps once the skeleton
runs.

## The line this project doesn't cross

No route in this scaffold submits an order, and none should be added without
you deciding that deliberately and separately — that's not a technical
limitation, it's the actual design intent: you and your friends stay the ones
making every decision and every trade.
