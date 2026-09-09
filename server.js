import "dotenv/config";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import express from "express";
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

// Minimal test UI (public/index.html) — signup/login forms and buttons that
// drive the same API routes above. Not a real dashboard, just enough to
// click through the flow by hand.
app.use(express.static(path.join(__dirname, "public")));

// Reports how far this user has actually gotten, so the front end can
// resume the wizard at the right step on reload — including the moment
// Schwab's OAuth redirect bounces the browser back to us.
app.get("/api/status", async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const [{ rows: conn }, { rows: holdings }] = await Promise.all([
    pool.query("SELECT 1 FROM schwab_connections WHERE user_id = $1 LIMIT 1", [req.session.userId]),
    pool.query("SELECT 1 FROM holdings WHERE user_id = $1 LIMIT 1", [req.session.userId]),
  ]);
  res.json({
    loggedIn: true,
    schwabConnected: conn.length > 0,
    hasHoldings: holdings.length > 0,
  });
});

const port = process.env.PORT || 3000;
if (useHttps) {
  const options = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  https.createServer(options, app).listen(port, () =>
    console.log(`Cardinal Personal running on https://127.0.0.1:${port} (self-signed cert — click through the browser warning once)`)
  );
} else {
  app.listen(port, () =>
    console.log(`Cardinal Personal running on http://localhost:${port} (no certs/ found — Schwab OAuth needs HTTPS, see README)`)
  );
}
