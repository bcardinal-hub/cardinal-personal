# Information Security Policy — Cardinal Finance AI

**Version 1.0 · September 2026 · Owner: Bryson Cardinal, Founder**
**Review cadence: every 6 months, or on any material change to the system or the team.**

## 1. Purpose and scope

This policy describes how Cardinal Finance AI protects user data — specifically the financial account data users authorize us to read, and the credentials protecting their accounts with us.

It covers the production application (`cardinal-personal.onrender.com`), its Postgres database, and every third-party service the application transmits user data to. It applies to every person with access to those systems.

**Current scope reality:** Cardinal Finance AI is operated by a single founder with no employees or contractors. One person holds all access. This policy is written for that reality and must be revised — specifically Sections 3 and 7 — before any second person is granted production access.

## 2. Data we handle

| Class | Examples | Sensitivity |
|---|---|---|
| **Authentication secrets** | Plaid access tokens, Schwab access/refresh tokens, user password hashes, session identifiers | **Critical** — compromise exposes a user's financial accounts |
| **Financial data** | Holdings: ticker, quantity, market value, cost basis | **High** — private, but read-only and not sufficient to move money |
| **Account data** | Email address, subscription status, app preferences | **Moderate** |
| **Derived content** | AI analysis, recommendations, chat history | **Moderate** — derived from the above |

**What we deliberately never hold:** bank or brokerage login credentials. Plaid and Schwab authenticate the user directly and return only a token. We never see a username or password for a linked institution, and no code path could store one.

## 3. Access control

- Production database and hosting credentials are held by the founder only, secured with unique passwords and multi-factor authentication where the provider supports it.
- Application secrets (`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, API keys) live in the hosting provider's environment configuration. They are never committed to source control; `.env` is gitignored.
- Users can access only their own data. Every data query is scoped by `user_id` from the server-side session — never from a client-supplied parameter.
- There is no administrative UI that exposes one user's financial data to another user or to the operator through the application.

**On adding a second person:** access is granted per-system on a least-privilege basis, and this section is rewritten before the grant, not after.

## 4. Encryption

**In transit:** All traffic is served over HTTPS/TLS. HSTS is enabled in production. All outbound calls to Plaid, Schwab, Stripe, Anthropic, and Finnhub are HTTPS.

**At rest:** Third-party access tokens — the most sensitive data we hold — are encrypted with **AES-256-GCM** before being written to the database, and decrypted only server-side at the moment of an API call. The encryption key is held in the environment, never in the database or source control. An attacker with a copy of the database alone cannot use the tokens in it.

Passwords are hashed with **bcrypt** (cost factor 12). They are never stored, logged, or recoverable in plaintext — a password reset issues a new credential rather than revealing the old one.

Sessions are stored **server-side in Postgres** (`connect-pg-simple`). The browser holds only an opaque session identifier in an HTTP-only cookie; no user data or token is readable client-side.

## 5. Application security controls

- **Read-only by design.** No route in the application can initiate a trade, transfer, withdrawal, or any write operation against a linked financial account. This is not a permission setting that could be misconfigured — the code to place an order does not exist, and the Plaid integration requests only the `investments` product.
- **No token ever reaches the browser.** Access tokens are decrypted only inside server-side request handlers and are never serialized into a response.
- Passwords are compared with a constant-time bcrypt comparison, run even for non-existent accounts against a dummy hash, so login timing does not reveal whether an email is registered.
- Rate limiting on authentication endpoints (login, signup, password reset) to limit credential-stuffing and brute-force attempts.
- Password reset tokens are stored hashed, single-use, and time-limited.
- All database access uses parameterized queries — no string-concatenated SQL.
- Security headers are set on all responses: Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors 'none'`, `Referrer-Policy`, and HSTS in production.

**Known limitation, stated honestly:** the current Content-Security-Policy includes `'unsafe-inline'` for scripts, because the interface relies on inline event handlers. CSP therefore does not currently mitigate inline-script XSS. This is a known gap, tracked for remediation by migrating to external event listeners.

## 6. Data retention and deletion

- Holdings data is retained only while the user's account exists and the connection remains linked.
- **Users can permanently delete their entire account themselves**, at any time, from within the app (Billing → Danger Zone). This revokes every linked Plaid connection on Plaid's side (`/item/remove`), cancels any active subscription, and immediately removes all access tokens, synced holdings, recommendations, and account records from the database. No support request, no waiting period, no retention of a shadow copy.
- Users can disconnect any individual linked institution from the Positions tab. This revokes the connection on Plaid's side (`/item/remove`) — so the account is no longer readable by us at all, not merely forgotten locally — and deletes our encrypted copy of the access token and the synced holdings.
- We do not sell user data, and we do not share it with any party other than the service providers listed in Section 7, each of which receives only what it needs to perform its function.

## 7. Third-party providers

| Provider | What it receives | Why |
|---|---|---|
| **Plaid** | Account connection tokens | Read-only holdings sync |
| **Charles Schwab** | OAuth tokens | Read-only holdings sync |
| **Neon** (Postgres) | All application data, tokens encrypted | Database hosting |
| **Render** | All application data in transit | Application hosting |
| **Stripe** | Email, subscription status | Billing — **card details go directly to Stripe and never touch our servers** |
| **Anthropic** | Holdings data (ticker, quantity, value) for analysis | AI analysis |
| **Finnhub** | Ticker symbols only — no user-identifying data | Market quotes and news |
| **Resend** | Email address | Transactional email (password reset) |

Providers are selected for their own security posture and are reviewed when added. No user data is sent to any provider not listed here.

## 8. Incident response

If a security incident is suspected:

1. **Contain** — revoke affected credentials immediately: rotate the token encryption key, invalidate all sessions, rotate provider API keys.
2. **Assess** — determine what data was accessible, which users are affected, and over what window.
3. **Notify** — affected users directly and without delay; Plaid and any other affected provider per their terms; regulators as applicable law requires.
4. **Remediate** — fix the root cause before restoring normal service.
5. **Document** — write up what happened, why, and what changed as a result, and update this policy accordingly.

**Security contact:** Bryson Cardinal, Founder — bcardkid@icloud.com

Given a single operator, notification is immediate rather than routed through an escalation chain. If the team grows, a defined on-call and escalation path replaces this paragraph.

## 9. Change management

- All changes are tracked in version control with a full commit history.
- Changes are tested before deploy; deploys are automated from the main branch.
- Database schema changes are applied as additive, idempotent migrations (`ADD COLUMN IF NOT EXISTS`) so a deploy cannot destroy existing data.
- Dependencies are kept current, with security advisories addressed promptly.

## 10. Honest statement of maturity

This is a deliberately accurate description of a small, early-stage system, not an aspirational one. Cardinal Finance AI does **not** currently have: a formal third-party security audit, SOC 2 or ISO 27001 certification, penetration testing, a dedicated security team, automated intrusion detection, or formal security awareness training.

What it does have is a narrow attack surface (read-only, one data product, no money movement), strong encryption of the data that actually matters, and a single accountable owner. Those controls are real and verifiable in the source code.

As the business grows, this policy grows with it. Anything asserted here is true today; nothing is asserted that is not.
