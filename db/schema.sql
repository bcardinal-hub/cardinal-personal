-- Each row in `users` is one person using this instance (you, or one friend
-- if they're running their own deployment of this same codebase).
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Schwab OAuth tokens, one row per user per connected Schwab account.
-- access_token expires in ~30 minutes; refresh it on each use and update
-- this row. access_token/refresh_token are encrypted at rest with
-- TOKEN_ENCRYPTION_KEY (see lib/crypto.js) before ever reaching this table.
CREATE TABLE schwab_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  schwab_account_id TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Plaid connections — the multi-tenant path for connecting ANY brokerage/
-- bank, not just Schwab (Schwab's Individual API can only ever authorize
-- the app registrant's own account; Plaid is what lets other subscribers
-- connect their own accounts). access_token encrypted at rest like Schwab's.
CREATE TABLE plaid_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  institution_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- A local cache of positions, refreshed on sync. This is what the analysis
-- agents read from — never hit Schwab/Plaid live on every question. `source`
-- distinguishes which connection a row came from, so syncing one doesn't
-- wipe the other's data.
CREATE TABLE holdings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'schwab' CHECK (source IN ('schwab', 'plaid')),
  ticker TEXT NOT NULL,
  quantity NUMERIC,
  market_value NUMERIC,
  cost_basis NUMERIC,
  day_change NUMERIC,
  day_change_pct NUMERIC,
  synced_at TIMESTAMPTZ DEFAULT now()
);

-- Same content-type discipline as the Cardinal architecture: every AI output
-- is a row here with a status, never something that silently "just happens."
CREATE TABLE recommendations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('fact','calculation','ai_observation','recommendation')),
  summary TEXT NOT NULL,
  reasoning TEXT,
  confidence TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','edited','rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Market/news snapshots are NOT per-user — the market looks the same to
-- everyone on this instance, so one shared cache avoids paying for the same
-- web-search-backed Claude call once per user. Refreshed on demand from the
-- Market/News tabs, not on a timer.
CREATE TABLE market_snapshots (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('overview', 'news')),
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Persisted history for the AI Assistant tab's free-form chat, scoped per
-- user like everything else personal.
CREATE TABLE chat_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- Advisor / household layer. Every signed-in user (`users` above) can also
-- act as an advisor tracking OTHER people's households — separate from their
-- own Schwab-connected personal portfolio above, which is untouched by this.
-- Schwab's Individual API can only ever connect the app-registrant's own
-- account, so financial data for these households is entered manually (or,
-- later, extracted from uploaded documents) rather than pulled live.
-- ============================================================================

-- One household per family/client relationship the advisor manages.
-- The estate/insurance flags are NULL ("not yet reviewed") until the
-- advisor sets them true/false — the Opportunity Engine treats NULL and
-- false both as a gap worth flagging, phrased differently (see
-- lib/opportunityEngine.js).
CREATE TABLE households (
  id SERIAL PRIMARY KEY,
  advisor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  advisor_notes TEXT,
  has_will BOOLEAN,
  has_trust BOOLEAN,
  has_poa BOOLEAN,
  beneficiaries_current BOOLEAN,
  life_insurance BOOLEAN,
  disability_insurance BOOLEAN,
  umbrella_insurance BOOLEAN,
  ltc_insurance BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- One person within a household — the primary client, a spouse, or another
-- family member on the same financial picture.
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'primary' CHECK (relationship IN ('primary', 'spouse', 'dependent', 'other')),
  date_of_birth DATE,
  employment_status TEXT,
  annual_income NUMERIC,
  risk_tolerance TEXT CHECK (risk_tolerance IN ('conservative', 'moderate', 'aggressive')),
  retirement_target_age INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Financial goals tied to a household (retirement, college, a home, etc.).
CREATE TABLE goals (
  id SERIAL PRIMARY KEY,
  household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  target_amount NUMERIC,
  target_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'abandoned')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Every asset/liability line item covers the spec's financial data model:
-- cash, brokerage, 401k, ira/roth, real estate, business ownership,
-- insurance, mortgage, credit/debt. Manually entered for now; a later
-- document-extraction pipeline would write into this same table.
CREATE TABLE financial_accounts (
  id SERIAL PRIMARY KEY,
  household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'cash', 'brokerage', '401k', 'ira', 'roth_ira', 'real_estate',
    'business_ownership', 'insurance', 'mortgage', 'credit_debt', 'other'
  )),
  is_liability BOOLEAN NOT NULL DEFAULT false,
  name TEXT NOT NULL,
  balance NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Recurring income/expense line items, for the household's cash flow.
CREATE TABLE cash_flow_items (
  id SERIAL PRIMARY KEY,
  household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
  name TEXT NOT NULL,
  monthly_amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- The Opportunity Engine's output. household_id is NULL for opportunities
-- scoped to the advisor's own Schwab-connected portfolio instead of a
-- managed household. Every row here comes from a deterministic rule in
-- lib/opportunityEngine.js — no LLM invents these numbers — same
-- content-type/approval discipline as `recommendations` above.
CREATE TABLE opportunities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
  -- 'deterministic' rows are pure arithmetic on real data (lib/opportunityEngine.js);
  -- 'ai' rows are judgment calls from a web-search-backed Claude agent
  -- (lib/tradeIdeas.js) — never conflate the two in the UI.
  source TEXT NOT NULL DEFAULT 'deterministic' CHECK (source IN ('deterministic', 'ai')),
  category TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  financial_impact NUMERIC,
  explanation TEXT NOT NULL,
  supporting_data JSONB,
  recommended_next_step TEXT NOT NULL,
  specialist_review_required BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'edited', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);
