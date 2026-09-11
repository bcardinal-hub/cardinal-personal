import "dotenv/config";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import express from "express";
// Must be imported right after express, before any routes are defined — it
// patches Router methods so a rejected promise in an `async` route handler
// calls next(err) instead of becoming an unhandled rejection that crashes
// the whole process (Express 4 doesn't do this on its own; Express 5 does,
// but upgrading is a bigger change than this fix warrants right now).
import "express-async-errors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";

import authRoutes from "./routes/auth.js";
import schwabRoutes from "./routes/schwab.js";
import analysisRoutes from "./routes/analysis.js";
import marketRoutes from "./routes/market.js";
import chatRoutes from "./routes/chat.js";
import householdsRoutes from "./routes/households.js";
import opportunitiesRoutes from "./routes/opportunities.js";
import plaidRoutes from "./routes/plaid.js";
import billingRoutes, { webhookHandler } from "./routes/billing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Schwab's OAuth callback must be HTTPS, even on localhost — no exceptions,
// their app-creation form rejects plain http:// callback URLs outright. So
// this server speaks HTTPS locally using a self-signed cert (certs/*.pem,
// generated once with the openssl command in README.md). The browser will
// show a one-time "not secure" warning for the self-signed cert; that's
// expected for local dev and fine to click through.
const certPath = path.join(__dirname, "certs", "cert.pem");
const keyPath = path.join(__dirname, "certs", "key.pem");
const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
// In production (Render/Railway/Fly/etc.) TLS is terminated at the host's
// edge proxy, not by this process — it receives plain HTTP internally but
// the real connection to the browser is HTTPS. `trust proxy` + this flag
// tell Express/express-session to treat that as a secure connection too.
const isProduction = process.env.NODE_ENV === "production";
const isSecureContext = useHttps || isProduction;

// Shared Postgres pool, attached to every request. Every route reads/writes
// through this rather than talking to Schwab live each time.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
if (isProduction) app.set("trust proxy", 1);

// Stripe's webhook needs the raw, unparsed request body to verify the
// signature — must be registered before express.json() touches the body,
// and needs req.db attached manually since the shared req.db middleware
// below also comes after this.
app.post("/billing/webhook", express.raw({ type: "application/json" }), (req, res, next) => {
  req.db = pool;
  next();
}, webhookHandler);

// Baseline security headers — hand-rolled rather than pulling in helmet
// for a handful of headers. CSP is deliberately not maximally strict:
// script-src/style-src need 'unsafe-inline' because the current UI relies
// on inline onclick="" handlers and inline <script>/<style> blocks
// throughout public/*.html, so this doesn't block inline-script XSS the
// way a nonce-based CSP would — a real gap, noted rather than glossed
// over. What it does meaningfully do: blocks this app from ever being
// framed by another site (clickjacking), blocks loading executable
// content from any origin outside what's actually used (Plaid, Google
// Fonts), and adds the standard MIME/referrer hardening.
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.plaid.com https://*.plaid.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://*.plaid.com",
      "frame-src https://cdn.plaid.com https://*.plaid.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  if (isProduction) res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  next();
});

app.use(express.json());
app.use(
  session({
    // Sessions live in Postgres (a "session" table, auto-created below), not
    // server memory — so restarting the dev server (which happens on every
    // file save with node --watch) no longer logs everyone out.
    store: new (connectPgSimple(session))({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: isSecureContext, maxAge: 30 * 24 * 60 * 60 * 1000 },
    rolling: true,
  })
);

app.use((req, res, next) => {
  req.db = pool;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  next();
}

app.use("/auth", authRoutes);
app.use("/schwab", requireLogin, schwabRoutes);
app.use("/analysis", requireLogin, analysisRoutes);
app.use("/market", requireLogin, marketRoutes);
app.use("/ai", requireLogin, chatRoutes);
app.use("/households", requireLogin, householdsRoutes);
app.use("/opportunities", requireLogin, opportunitiesRoutes);
app.use("/plaid", requireLogin, plaidRoutes);
app.use("/billing", requireLogin, billingRoutes);

// Minimal test UI (public/index.html) — signup/login forms and buttons that
// drive the same API routes above. Not a real dashboard, just enough to
// click through the flow by hand.
app.use(express.static(path.join(__dirname, "public")));

// Reports how far this user has actually gotten, so the front end can
// resume the wizard at the right step on reload — including the moment
// Schwab's OAuth redirect bounces the browser back to us.
app.get("/api/status", async (req, res) => {
  // codePending: password passed but the emailed sign-in code hasn't been
  // entered yet — lets a reload land back on the code screen, not sign-in.
  if (!req.session.userId) return res.json({ loggedIn: false, codePending: Boolean(req.session.pendingUserId) });
  const [{ rows: schwab }, { rows: plaid }, { rows: holdings }] = await Promise.all([
    pool.query("SELECT 1 FROM schwab_connections WHERE user_id = $1 LIMIT 1", [req.session.userId]),
    pool.query("SELECT 1 FROM plaid_connections WHERE user_id = $1 LIMIT 1", [req.session.userId]),
    pool.query("SELECT 1 FROM holdings WHERE user_id = $1 LIMIT 1", [req.session.userId]),
  ]);
  res.json({
    loggedIn: true,
    schwabConnected: schwab.length > 0,
    plaidConnected: plaid.length > 0,
    // Almost every real subscriber connects via Plaid, not Schwab (Schwab's
    // Individual tier only ever authorizes the app registrant's own
    // account) — the wizard gates on "connected to *something*", not Schwab
    // specifically.
    accountConnected: schwab.length > 0 || plaid.length > 0,
    hasHoldings: holdings.length > 0,
  });
});

// Catches anything express-async-errors forwards, and anything a route
// passed to next(err) directly. Always last. Never crashes the process —
// that's the whole point.
app.use((err, req, res, next) => {
  console.error("Unhandled route error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong on our end. Please try again." });
});

// Defense in depth: if something still slips past the above (e.g. a
// rejection outside a request, like an unawaited background call), log it
// instead of letting Node kill the whole process and take every user down
// with it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

const port = process.env.PORT || 3000;
if (useHttps) {
  const options = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  https.createServer(options, app).listen(port, () =>
    console.log(`Cardinal Finance AI running on https://127.0.0.1:${port} (self-signed cert — click through the browser warning once)`)
  );
} else {
  app.listen(port, () =>
    console.log(`Cardinal Finance AI running on http://localhost:${port} (no certs/ found — Schwab OAuth needs HTTPS, see README)`)
  );
}
