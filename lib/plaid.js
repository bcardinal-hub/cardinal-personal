// Thin wrapper over Plaid's REST API — no SDK dependency needed, just plain
// fetch calls with client_id/secret in the body, same pattern as schwab.js.
import fetch from "node-fetch";

const PLAID_ENV = process.env.PLAID_ENV || "sandbox";
const PLAID_BASE = `https://${PLAID_ENV}.plaid.com`;

async function plaidRequest(path, body) {
  const response = await fetch(`${PLAID_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      ...body,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_message || `Plaid request to ${path} failed (${response.status})`);
  }
  return data;
}

// Creates a Link token so the browser-side Plaid Link widget can launch for
// this user. investments product = holdings/positions data.
export async function createLinkToken(userId) {
  const data = await plaidRequest("/link/token/create", {
    user: { client_user_id: String(userId) },
    client_name: "Cardinal Finance AI",
    products: ["investments"],
    country_codes: ["US"],
    language: "en",
  });
  return data.link_token;
}

// Exchanges the one-time public_token (from Link's onSuccess callback) for a
// long-lived access_token — this is the token that actually reads data,
// and it never reaches the browser.
export async function exchangePublicToken(publicToken) {
  const data = await plaidRequest("/item/public_token/exchange", { public_token: publicToken });
  return { accessToken: data.access_token, itemId: data.item_id };
}

export async function getInstitutionName(itemId, accessToken) {
  try {
    const item = await plaidRequest("/item/get", { access_token: accessToken });
    if (!item.item.institution_id) return null;
    const inst = await plaidRequest("/institutions/get_by_id", {
      institution_id: item.item.institution_id,
      country_codes: ["US"],
    });
    return inst.institution?.name || null;
  } catch {
    return null; // cosmetic only — never block a connection over this
  }
}

// Returns holdings mapped to our schema's shape: {ticker, quantity,
// market_value, cost_basis}. Plaid's cost_basis is a TOTAL for the holding,
// not per-share like Schwab's averagePrice, so we divide it out to keep the
// same column semantics across both sources.
export async function getInvestmentHoldings(accessToken) {
  const data = await plaidRequest("/investments/holdings/get", { access_token: accessToken });
  const securitiesById = new Map((data.securities || []).map((s) => [s.security_id, s]));
  return (data.holdings || [])
    .map((h) => {
      const security = securitiesById.get(h.security_id);
      const ticker = security?.ticker_symbol;
      if (!ticker) return null; // skip holdings Plaid can't resolve to a tradeable symbol
      const quantity = h.quantity;
      const costBasisPerShare = h.cost_basis != null && quantity ? h.cost_basis / quantity : null;
      return {
        ticker,
        quantity,
        market_value: h.institution_value ?? (quantity != null && h.institution_price != null ? quantity * h.institution_price : null),
        cost_basis: costBasisPerShare,
      };
    })
    .filter(Boolean);
}
