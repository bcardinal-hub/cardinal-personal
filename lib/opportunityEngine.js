// Deterministic rule engine — every number here comes from real arithmetic
// on the advisor's actual entered/synced data, never an LLM guess. This is
// intentional: per the project's own ground rules, financial calculations
// are code, not model output. Each rule returns zero or one opportunity
// object shaped for the `opportunities` table.

const RMD_AGE = 73; // current SEC/IRS-set RMD start age as of this build
const ASSUMED_GROWTH_RATE = 0.06; // simple nominal assumption, clearly labeled as such downstream
const SAFE_WITHDRAWAL_MULTIPLE = 25; // the "4% rule" target: 25x annual expenses

function ageFromDob(dob) {
  if (!dob) return null;
  return Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000));
}

function sumBy(rows, pred) {
  return rows.filter(pred).reduce((s, r) => s + Number(r.balance ?? r.monthly_amount ?? 0), 0);
}

// ---- Household-scoped rules ----

function checkExcessCash(household) {
  const { accounts, cashFlow } = household;
  const cash = sumBy(accounts, (a) => a.category === "cash" && !a.is_liability);
  const monthlyExpenses = sumBy(cashFlow, (c) => c.kind === "expense");
  if (cash <= 0) return null;

  if (monthlyExpenses > 0) {
    const reserveTarget = monthlyExpenses * 6;
    if (cash <= reserveTarget) return null;
    const excess = cash - reserveTarget;
    return {
      category: "Excess Cash",
      priority: excess > 100000 ? "high" : excess > 25000 ? "medium" : "low",
      confidence: "high",
      financial_impact: excess,
      explanation: `Household holds $${cash.toLocaleString()} in cash against $${monthlyExpenses.toLocaleString()}/mo of tracked expenses (a ${(cash / monthlyExpenses).toFixed(1)}-month reserve). Six months' reserve is $${reserveTarget.toLocaleString()}, leaving roughly $${excess.toLocaleString()} sitting idle beyond that buffer.`,
      supporting_data: { cash, monthlyExpenses, reserveTarget, excess },
      recommended_next_step: "Discuss deploying the excess above a 6-month reserve — paying down high-rate debt, funding tax-advantaged accounts, or investing per the household's goals and risk tolerance.",
      specialist_review_required: false,
    };
  }
  // No expense data on file — fall back to an absolute threshold, lower confidence.
  if (cash > 250000) {
    return {
      category: "Excess Cash",
      priority: "medium",
      confidence: "low",
      financial_impact: null,
      explanation: `Household holds $${cash.toLocaleString()} in cash. No monthly expenses are on file to size an appropriate reserve, so this is flagged on the raw balance alone — worth a real look, not a precise figure.`,
      supporting_data: { cash },
      recommended_next_step: "Log the household's monthly expenses to size an appropriate cash reserve, then revisit this.",
      specialist_review_required: false,
    };
  }
  return null;
}

function checkRetirementShortfall(household) {
  const { clients, accounts, cashFlow } = household;
  const retirementAssets = sumBy(accounts, (a) => !a.is_liability && ["401k", "ira", "roth_ira", "brokerage"].includes(a.category));
  const annualExpenses = sumBy(cashFlow, (c) => c.kind === "expense") * 12;
  const annualSurplus = (sumBy(cashFlow, (c) => c.kind === "income") - sumBy(cashFlow, (c) => c.kind === "expense")) * 12;
  if (annualExpenses <= 0) return null;

  const opportunities = [];
  for (const client of clients) {
    const age = ageFromDob(client.date_of_birth);
    if (age == null || !client.retirement_target_age) continue;
    const years = client.retirement_target_age - age;
    if (years <= 0) continue;

    const fvLumpSum = retirementAssets * Math.pow(1 + ASSUMED_GROWTH_RATE, years);
    const fvContributions = annualSurplus > 0
      ? annualSurplus * ((Math.pow(1 + ASSUMED_GROWTH_RATE, years) - 1) / ASSUMED_GROWTH_RATE)
      : 0;
    const projected = fvLumpSum + fvContributions;
    const target = annualExpenses * SAFE_WITHDRAWAL_MULTIPLE;

    if (projected < target) {
      const shortfall = target - projected;
      opportunities.push({
        category: "Retirement Shortfall",
        priority: shortfall > target * 0.4 ? "high" : shortfall > target * 0.15 ? "medium" : "low",
        confidence: "medium",
        financial_impact: shortfall,
        explanation: `Projecting ${client.full_name}'s target retirement at age ${client.retirement_target_age} (${years} years out): current household retirement/brokerage assets of $${Math.round(retirementAssets).toLocaleString()} plus the tracked annual cash-flow surplus, growing at an assumed ${(ASSUMED_GROWTH_RATE * 100).toFixed(0)}%/yr, projects to roughly $${Math.round(projected).toLocaleString()}. A 25x-annual-expenses target (the "4% rule") on $${Math.round(annualExpenses).toLocaleString()}/yr of tracked expenses is $${Math.round(target).toLocaleString()} — a gap of about $${Math.round(shortfall).toLocaleString()}.`,
        supporting_data: { client: client.full_name, age, retirementTargetAge: client.retirement_target_age, years, retirementAssets, annualSurplus, projected, target, assumedGrowthRate: ASSUMED_GROWTH_RATE },
        recommended_next_step: "Review savings rate, retirement timeline, and asset allocation with the client — this is a simplified projection, not a full retirement plan (see Retirement Engine for a fuller model).",
        specialist_review_required: true,
      });
    }
  }
  return opportunities;
}

function checkUpcomingRmds(household) {
  const { clients, accounts } = household;
  const pretaxBalance = sumBy(accounts, (a) => !a.is_liability && ["401k", "ira"].includes(a.category));
  if (pretaxBalance <= 0) return [];
  const opportunities = [];
  for (const client of clients) {
    const age = ageFromDob(client.date_of_birth);
    if (age == null || age < RMD_AGE) continue;
    opportunities.push({
      category: "Upcoming RMD",
      priority: "high",
      confidence: "high",
      financial_impact: null,
      explanation: `${client.full_name} is ${age}, past the current RMD age of ${RMD_AGE}. The household has $${Math.round(pretaxBalance).toLocaleString()} in pre-tax 401(k)/IRA accounts on file, which are subject to Required Minimum Distributions.`,
      supporting_data: { client: client.full_name, age, rmdAge: RMD_AGE, pretaxBalance },
      recommended_next_step: "Confirm this year's RMD has been calculated and taken from the correct accounts to avoid the IRS excise tax penalty on missed RMDs.",
      specialist_review_required: true,
    });
  }
  return opportunities;
}

function checkEstateAndInsuranceGaps(household) {
  const opportunities = [];
  const missingLabel = (v) => (v === false ? "confirmed missing" : "not yet reviewed");

  const estateFields = [["has_will", "a will"], ["has_trust", "a trust"], ["has_poa", "power of attorney"]];
  const missingEstate = estateFields.filter(([field]) => household[field] !== true);
  if (missingEstate.length) {
    opportunities.push({
      category: "Missing Estate Documents",
      priority: "medium",
      confidence: "high",
      financial_impact: null,
      explanation: `${missingEstate.map(([field, label]) => `${label} (${missingLabel(household[field])})`).join(", ")} — not confirmed on file for this household.`,
      supporting_data: { missing: missingEstate.map(([field]) => field) },
      recommended_next_step: "Confirm estate document status with the client and refer to an estate attorney for anything genuinely missing.",
      specialist_review_required: true,
    });
  }

  if (household.beneficiaries_current !== true) {
    opportunities.push({
      category: "Missing Beneficiaries",
      priority: "high",
      confidence: "high",
      financial_impact: null,
      explanation: `Beneficiary designations are ${missingLabel(household.beneficiaries_current)} for this household's accounts. Outdated or missing beneficiaries are one of the most common — and most consequential — estate-planning gaps.`,
      supporting_data: { beneficiariesCurrent: household.beneficiaries_current },
      recommended_next_step: "Pull current beneficiary designations from each account custodian and confirm they match the client's actual wishes.",
      specialist_review_required: false,
    });
  }

  const insuranceFields = [["life_insurance", "life"], ["disability_insurance", "disability"], ["umbrella_insurance", "umbrella"], ["ltc_insurance", "long-term care"]];
  const missingInsurance = insuranceFields.filter(([field]) => household[field] !== true);
  if (missingInsurance.length) {
    opportunities.push({
      category: "Insurance Gaps",
      priority: "medium",
      confidence: "high",
      financial_impact: null,
      explanation: `${missingInsurance.map(([field, label]) => `${label} insurance (${missingLabel(household[field])})`).join(", ")} — not confirmed in force for this household.`,
      supporting_data: { missing: missingInsurance.map(([field]) => field) },
      recommended_next_step: "Review current coverage against the household's actual risk exposure and refer to an insurance professional where gaps are confirmed.",
      specialist_review_required: true,
    });
  }

  return opportunities;
}

// Runs every household-scoped rule and returns a flat array of opportunity
// rows (without user_id/household_id — the caller attaches those before insert).
export function scanHousehold(household) {
  const results = [];
  const excessCash = checkExcessCash(household);
  if (excessCash) results.push(excessCash);
  results.push(...checkRetirementShortfall(household));
  results.push(...checkUpcomingRmds(household));
  results.push(...checkEstateAndInsuranceGaps(household));
  return results;
}

// Same simplified projection math as checkRetirementShortfall above, but
// for a self-directed personal user instead of an advisor's household
// client — retirementAssets comes straight from synced holdings (real
// market value, not a manually-entered balance), and the person's own
// profile fields (users.date_of_birth/retirement_target_age/
// monthly_expenses/monthly_contribution) stand in for what a household's
// clients/cashFlow rows provide. Returns null if there isn't enough
// profile data to compute anything, rather than nagging for it here — the
// UI's own empty state handles prompting for it.
export function personalRetirementOutlook(holdings, profile) {
  const age = ageFromDob(profile?.date_of_birth);
  const targetAge = profile?.retirement_target_age;
  if (age == null || !targetAge) return null;
  const years = targetAge - age;
  if (years <= 0) return null;

  const monthlyExpenses = Number(profile?.monthly_expenses) || 0;
  const annualExpenses = monthlyExpenses * 12;
  if (annualExpenses <= 0) return null;

  const retirementAssets = holdings.reduce((sum, h) => sum + (Number(h.market_value) || 0), 0);
  const annualContribution = (Number(profile?.monthly_contribution) || 0) * 12;

  const fvLumpSum = retirementAssets * Math.pow(1 + ASSUMED_GROWTH_RATE, years);
  const fvContributions = annualContribution > 0
    ? annualContribution * ((Math.pow(1 + ASSUMED_GROWTH_RATE, years) - 1) / ASSUMED_GROWTH_RATE)
    : 0;
  const projected = fvLumpSum + fvContributions;
  const target = annualExpenses * SAFE_WITHDRAWAL_MULTIPLE;

  return {
    age,
    targetAge,
    years,
    retirementAssets,
    annualExpenses,
    annualContribution,
    projected,
    target,
    gap: target - projected,
    onTrack: projected >= target,
    assumedGrowthRate: ASSUMED_GROWTH_RATE,
    safeWithdrawalMultiple: SAFE_WITHDRAWAL_MULTIPLE,
  };
}

// ---- Personal-portfolio-scoped rules (household_id NULL) ----

// Position concentration is pure arithmetic — what share of the portfolio
// is riding on one name. The Chief Risk Officer agent already comments on
// this, but its read is a judgment call; the percentage itself is math and
// belongs here, tagged 'deterministic', so the number is never something a
// model produced. Thresholds are deliberately conservative and stated
// plainly rather than presented as a rule: a 25%+ single position is
// meaningfully concentrated by most diversification conventions, not a
// verdict that it's wrong.
const CONCENTRATION_HIGH = 40;
const CONCENTRATION_MEDIUM = 25;

function checkConcentration(holdings) {
  const total = holdings.reduce((sum, h) => sum + (Number(h.market_value) || 0), 0);
  if (total <= 0) return null;

  // Group by ticker first — the same position can arrive as several rows
  // across accounts or lots, and three 15% lots of one stock is a 45%
  // position, not three small ones.
  const byTicker = new Map();
  for (const h of holdings) {
    byTicker.set(h.ticker, (byTicker.get(h.ticker) || 0) + (Number(h.market_value) || 0));
  }
  const ranked = [...byTicker.entries()]
    .map(([ticker, value]) => ({ ticker, value, pct: (value / total) * 100 }))
    .sort((a, b) => b.pct - a.pct);

  const top = ranked[0];
  if (!top || top.pct < CONCENTRATION_MEDIUM) return null;
  // A single holding is 100% concentrated by definition — say that plainly
  // rather than dressing it up as a discovered finding.
  const onlyPosition = ranked.length === 1;

  return {
    category: `Concentration Risk — ${top.ticker}`,
    priority: top.pct >= CONCENTRATION_HIGH ? "high" : "medium",
    confidence: "high", // it's arithmetic, not an opinion
    financial_impact: top.value,
    explanation: onlyPosition
      ? `${top.ticker} is your entire synced portfolio — 100% of $${Math.round(total).toLocaleString()}. Everything you've invested depends on one company's outcome, with nothing else to offset a bad one.`
      : `${top.ticker} is ${top.pct.toFixed(1)}% of your synced portfolio ($${Math.round(top.value).toLocaleString()} of $${Math.round(total).toLocaleString()}). Your top ${Math.min(3, ranked.length)} positions are ${ranked.slice(0, 3).reduce((s, r) => s + r.pct, 0).toFixed(1)}% combined (${ranked.slice(0, 3).map((r) => `${r.ticker} ${r.pct.toFixed(1)}%`).join(", ")}).`,
    supporting_data: {
      totalValue: total,
      positions: ranked.map((r) => ({ ticker: r.ticker, value: r.value, pct: Number(r.pct.toFixed(2)) })),
      topPct: Number(top.pct.toFixed(2)),
      thresholds: { medium: CONCENTRATION_MEDIUM, high: CONCENTRATION_HIGH },
    },
    recommended_next_step: `Whether this is too concentrated depends on your own timeline and risk tolerance — a conviction position isn't automatically a mistake. What's worth knowing is that ${top.pct.toFixed(0)}% of your outcome rides on ${top.ticker} specifically. If you'd rather spread that, broad index funds are the usual way people do it. You place any trade yourself.`,
    specialist_review_required: false,
  };
}

export function scanPersonalPortfolio({ holdings, recommendations }) {
  const results = [];

  const concentration = checkConcentration(holdings);
  if (concentration) results.push(concentration);

  const losers = holdings
    .map((h) => ({ ...h, unrealizedLoss: Number(h.market_value || 0) - Number(h.cost_basis || 0) * Number(h.quantity || 0) }))
    .filter((h) => h.unrealizedLoss < -1);
  if (losers.length) {
    const totalLoss = losers.reduce((s, h) => s + h.unrealizedLoss, 0);
    results.push({
      category: "Tax-Loss Harvesting Candidate",
      priority: Math.abs(totalLoss) > 5000 ? "high" : Math.abs(totalLoss) > 1000 ? "medium" : "low",
      confidence: "high",
      financial_impact: totalLoss,
      explanation: `${losers.length} synced position${losers.length === 1 ? "" : "s"} currently sit below cost basis: ${losers.map((h) => `${h.ticker} ($${Math.round(h.unrealizedLoss).toLocaleString()})`).join(", ")}. Combined unrealized loss: $${Math.round(totalLoss).toLocaleString()}.`,
      supporting_data: { positions: losers.map((h) => ({ ticker: h.ticker, unrealizedLoss: h.unrealizedLoss })), totalLoss },
      recommended_next_step: "Evaluate harvesting these losses to offset gains elsewhere — watch the wash-sale rule (no repurchase of a substantially identical security within 30 days). You place any resulting trade yourself.",
      specialist_review_required: true,
    });
  }

  const stale = recommendations.filter((r) => {
    if (r.status !== "pending_review") return false;
    const ageDays = (Date.now() - new Date(r.created_at).getTime()) / (24 * 3600 * 1000);
    return ageDays > 3;
  });
  if (stale.length) {
    results.push({
      category: "Unfinished Recommendations",
      priority: stale.length > 5 ? "high" : "medium",
      confidence: "high",
      financial_impact: null,
      explanation: `${stale.length} agent recommendation${stale.length === 1 ? "" : "s"} on your own portfolio have sat pending review for more than 3 days.`,
      supporting_data: { count: stale.length, ids: stale.map((r) => r.id) },
      recommended_next_step: "Review and approve, edit, or dismiss the outstanding recommendations in the Recommendations tab.",
      specialist_review_required: false,
    });
  }

  return results;
}
