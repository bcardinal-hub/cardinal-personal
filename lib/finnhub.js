// Real market data — quotes and news come from here, never from an LLM.
// Free-tier Finnhub: instant signup, no approval wait, ~60 calls/min.
import fetch from "node-fetch";

const BASE = "https://finnhub.io/api/v1";

async function finnhubGet(path, params) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("token", process.env.FINNHUB_API_KEY);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Finnhub request to ${path} failed (${response.status})`);
  }
  return response.json();
}

// Widely-tracked ETF proxies for the major indices — Finnhub's free tier
// doesn't reliably support raw index symbols (^GSPC etc.) but these track
// closely enough for a "how's the market doing" glance.
export const INDEX_PROXIES = [
  { symbol: "SPY", label: "S&P 500" },
  { symbol: "QQQ", label: "Nasdaq" },
  { symbol: "DIA", label: "Dow 30" },
  { symbol: "IWM", label: "Russell 2000" },
];

// Individually tracked tickers shown alongside the indices, regardless of
// whether the user actually holds them — a simple fixed watchlist for now.
export const WATCHLIST = ["NVDA"];

// The 11 GICS sector SPDR ETFs — same "ETF proxy" trick as the indices
// above, real breadth data with zero extra API surface. This is what the
// Market tab has that Terminal doesn't: not just "is the market up," but
// which parts of it, which actually explains why a tech-heavy portfolio
// is moving differently than the S&P headline number.
export const SECTOR_PROXIES = [
  { symbol: "XLK", label: "Technology" },
  { symbol: "XLF", label: "Financials" },
  { symbol: "XLV", label: "Health Care" },
  { symbol: "XLY", label: "Consumer Discretionary" },
  { symbol: "XLP", label: "Consumer Staples" },
  { symbol: "XLE", label: "Energy" },
  { symbol: "XLI", label: "Industrials" },
  { symbol: "XLB", label: "Materials" },
  { symbol: "XLU", label: "Utilities" },
  { symbol: "XLRE", label: "Real Estate" },
  { symbol: "XLC", label: "Communication Services" },
];

export async function getQuote(symbol) {
  const q = await finnhubGet("/quote", { symbol });
  // Finnhub returns all-zero fields for an unknown/delisted symbol instead
  // of an error — treat that as "no data" rather than a real $0 quote.
  if (q.c === 0 && q.pc === 0) return null;
  return { symbol, price: q.c, change: q.d, changePct: q.dp, high: q.h, low: q.l, open: q.o, prevClose: q.pc };
}

export async function getQuotes(symbols) {
  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        return await getQuote(symbol);
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

// Real upcoming earnings dates for specific tickers. Worth having as hard
// data rather than letting an agent web-search for it: a spot check found
// searched dates off by a day (agent said Apple reports Oct 29; the real
// scheduled date is Oct 28). "hour" is Finnhub's bmo/amc/dmh — before
// market open, after market close, during market hours.
export async function getEarningsCalendar(symbols, daysAhead = 120) {
  if (!symbols.length) return [];
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + daysAhead * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const data = await finnhubGet("/calendar/earnings", { from, to, symbol });
        const next = (data.earningsCalendar || [])[0];
        if (!next?.date) return null;
        return {
          symbol,
          date: next.date,
          hour: next.hour || null,
          quarter: next.quarter ?? null,
          epsEstimate: next.epsEstimate ?? null,
          revenueEstimate: next.revenueEstimate ?? null,
          daysAway: Math.round((new Date(next.date + "T00:00:00Z").getTime() - Date.now()) / (24 * 3600 * 1000)),
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean).sort((a, b) => new Date(a.date) - new Date(b.date));
}

export async function getMarketNews(limit = 12) {
  const items = await finnhubGet("/news", { category: "general" });
  return (items || []).slice(0, limit).map(mapNewsItem);
}

export async function getCompanyNews(symbol, limit = 3) {
  const to = new Date();
  const from = new Date(Date.now() - 5 * 24 * 3600 * 1000); // last 5 days
  const fmt = (d) => d.toISOString().slice(0, 10);
  const items = await finnhubGet("/company-news", { symbol, from: fmt(from), to: fmt(to) });
  return (items || []).slice(0, limit).map((item) => ({ ...mapNewsItem(item), ticker: symbol }));
}

function mapNewsItem(item) {
  return {
    headline: item.headline,
    summary: item.summary,
    source: item.source,
    url: item.url,
    datetime: item.datetime ? new Date(item.datetime * 1000).toISOString() : null,
    image: item.image || null,
  };
}
