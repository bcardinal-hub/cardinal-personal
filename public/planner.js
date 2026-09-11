// Budget & Cash Plan — shared by the public Learn page (learn.html) and the
// dashboard's Learn tab. Pure arithmetic in the browser: nothing typed here
// is sent to the server; inputs are remembered only in this browser's
// localStorage. Same "financial calculations are code, not model output"
// rule as lib/opportunityEngine.js, and the same 6%/yr growth assumption
// its retirement math uses, labeled as an assumption wherever it's shown.
(function () {
  const ASSUMED_GROWTH_RATE = 0.06;
  const ASSUMED_INFLATION = 0.03;
  const STORAGE_KEY = 'cfai_money_plan_v1';

  const NEEDS = [
    ['rent', 'Rent / housing'],
    ['utilities', 'Utilities & phone'],
    ['groceries', 'Groceries'],
    ['transport', 'Car / gas / transit'],
    ['insurance', 'Insurance'],
    ['minDebt', 'Minimum debt payments'],
  ];
  const WANTS = [
    ['eatingOut', 'Eating out & coffee'],
    ['shopping', 'Shopping'],
    ['subscriptions', 'Subscriptions'],
    ['fun', 'Fun & travel'],
    ['otherWants', 'Other'],
  ];

  const CSS = `
    .mp { font-size: 14px; color: var(--text, #211d16); }
    .mp-card { background: var(--panel, #fff); border: 1px solid var(--border, #e5dac0); border-radius: 16px; padding: 22px; margin-bottom: 14px; }
    .mp-card h3 { font-size: 17px; margin: 0 0 4px; }
    .mp-sub { color: var(--dim, #6e6656); font-size: 13px; margin: 0 0 16px; line-height: 1.6; }
    .mp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px 14px; }
    .mp-field label { display: block; font-size: 12px; font-weight: 600; color: var(--dim, #6e6656); margin-bottom: 4px; }
    .mp-field input, .mp-field select {
      width: 100%; padding: 10px 12px; font: inherit; font-size: 14px; border-radius: 10px;
      border: 1px solid var(--border, #e5dac0); background: var(--panel-2, #f6f1e6); color: inherit; outline: none;
    }
    .mp-field input:focus, .mp-field select:focus { border-color: var(--accent, #9c7a3c); }
    .mp-group { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--accent, #9c7a3c); margin: 18px 0 8px; }
    .mp-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 18px; }
    .mp-stat { background: var(--panel-2, #f6f1e6); border-radius: 12px; padding: 12px 14px; }
    .mp-stat .k { font-size: 11px; font-weight: 600; color: var(--dim, #6e6656); text-transform: uppercase; letter-spacing: .04em; }
    .mp-stat .v { font-size: 20px; font-weight: 700; margin-top: 2px; }
    .mp-bar { margin-top: 12px; }
    .mp-bar-row { display: grid; grid-template-columns: 96px 1fr 110px; align-items: center; gap: 10px; font-size: 12.5px; margin-bottom: 7px; }
    .mp-track { height: 9px; background: var(--panel-3, #eee5d1); border-radius: 6px; overflow: hidden; position: relative; }
    .mp-fill { height: 100%; background: var(--accent, #9c7a3c); border-radius: 6px; }
    .mp-mark { position: absolute; top: -2px; width: 2px; height: 13px; background: var(--navy, #16233d); }
    .mp-note { font-size: 13px; line-height: 1.65; margin: 12px 0 0; padding: 11px 14px; border-radius: 10px; background: var(--panel-2, #f6f1e6); }
    .mp-warn { background: #fdecea; color: #8a1c12; }
    .mp-steps { list-style: none; margin: 0; padding: 0; counter-reset: step; }
    .mp-steps li { position: relative; padding: 12px 0 12px 40px; border-top: 1px solid var(--border-soft, #ece3d0); line-height: 1.6; }
    .mp-steps li:first-child { border-top: none; }
    .mp-steps li::before {
      counter-increment: step; content: counter(step); position: absolute; left: 0; top: 12px;
      width: 26px; height: 26px; border-radius: 8px; background: var(--panel-3, #eee5d1); color: var(--accent, #9c7a3c);
      font-weight: 700; font-size: 12.5px; display: flex; align-items: center; justify-content: center;
    }
    .mp-steps li.done::before { content: '✓'; background: #e6f4ea; color: #1e6b34; }
    .mp-steps strong { color: var(--text, #211d16); }
    .mp-steps .amt { font-weight: 700; }
    .mp-dim { color: var(--dim, #6e6656); }
    .mp-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    @media (max-width: 560px) { .mp-compare { grid-template-columns: 1fr; } .mp-bar-row { grid-template-columns: 80px 1fr 90px; } }
    .mp-fine { font-size: 11.5px; color: var(--dim-2, #a49a84); line-height: 1.6; margin-top: 14px; }
  `;

  const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.round(n));
  const pct = (n) => `${Math.round(n * 100)}%`;
  const num = (v) => { const n = parseFloat(String(v || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };

  // Future value with monthly compounding: a lump sum today plus a fixed
  // monthly addition, at an assumed annual rate.
  function futureValue(lump, monthly, rate, years) {
    const i = rate / 12, n = years * 12, g = Math.pow(1 + i, n);
    return lump * g + monthly * ((g - 1) / i);
  }

  function field(id, label, placeholder, value) {
    return `<div class="mp-field"><label for="mp-${id}">${label}</label>` +
      `<input id="mp-${id}" data-k="${id}" inputmode="decimal" placeholder="${placeholder}" value="${value ?? ''}" /></div>`;
  }

  function load() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; } }
  function save(state) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }

  function compute(s) {
    const income = num(s.income);
    const needs = NEEDS.reduce((t, [k]) => t + num(s[k]), 0);
    const wants = WANTS.reduce((t, [k]) => t + num(s[k]), 0);
    const spending = needs + wants;
    const leftover = income - spending;

    const months = num(s.efMonths) || 6;
    const efTarget = spending * months;
    const cash = num(s.cash);
    const debt = num(s.debt);
    const shortTerm = num(s.shortTerm);

    // Walk the cash down the standard order of operations.
    let remaining = cash;
    const toEf = Math.min(remaining, efTarget); remaining -= toEf;
    const toDebt = Math.min(remaining, debt); remaining -= toDebt;
    const toShort = Math.min(remaining, shortTerm); remaining -= toShort;
    const longTerm = remaining;

    return { income, needs, wants, spending, leftover, months, efTarget, cash, debt, shortTerm, toEf, toDebt, toShort, longTerm };
  }

  function barRow(label, share, target) {
    const w = Math.max(0, Math.min(1, share));
    return `<div class="mp-bar-row"><div>${label}</div>` +
      `<div class="mp-track"><div class="mp-fill" style="width:${w * 100}%"></div><div class="mp-mark" style="left:${target * 100}%"></div></div>` +
      `<div class="mp-dim">${pct(share)} <span style="opacity:.7">(goal ~${pct(target)})</span></div></div>`;
  }

  function renderBudgetResults(c) {
    if (!c.income && !c.spending) return `<p class="mp-note mp-dim">Fill in your take-home pay and a few expenses to see where your money goes.</p>`;
    const saveRate = c.income ? c.leftover / c.income : 0;
    let out = `<div class="mp-stats">
      <div class="mp-stat"><div class="k">Spending / month</div><div class="v">${money(c.spending)}</div></div>
      <div class="mp-stat"><div class="k">Left over / month</div><div class="v" style="color:${c.leftover < 0 ? '#8a1c12' : 'inherit'}">${money(c.leftover)}</div></div>
      <div class="mp-stat"><div class="k">Savings rate</div><div class="v">${c.income ? pct(Math.max(0, saveRate)) : '—'}</div></div>
    </div>`;
    if (c.income) {
      out += `<div class="mp-bar">
        ${barRow('Needs', c.needs / c.income, 0.5)}
        ${barRow('Wants', c.wants / c.income, 0.3)}
        ${barRow('Saving', Math.max(0, saveRate), 0.2)}
      </div>`;
    }
    if (c.income && c.leftover < 0) {
      out += `<p class="mp-note mp-warn">You're spending ${money(-c.leftover)} more than you bring in each month. That's the first thing to fix — before investing — or savings and credit cards slowly cover the gap.</p>`;
    } else if (c.income) {
      const tip = saveRate >= 0.2
        ? `You're saving ${pct(saveRate)} of your take-home pay — at or above the 20% most educators suggest. The question now is where that money goes, which is what the plan below is for.`
        : `The 50/30/20 rule is a common starting point: about 50% of take-home pay on needs, 30% on wants, 20% saved. You're at ${pct(Math.max(0, saveRate))} saved — ${c.wants > 0 ? `trimming wants by ${money(Math.min(c.wants, c.income * 0.2 - Math.max(0, c.leftover)))} a month would get you to 20%.` : 'small, steady increases add up.'}`;
      out += `<p class="mp-note">${tip}</p>`;
    }
    return out;
  }

  function renderPlan(c, s) {
    if (!c.cash) return `<p class="mp-note mp-dim">Enter how much cash you have sitting in checking and savings to see a step-by-step plan for it.</p>`;
    const needSpending = c.spending === 0;
    const steps = [];

    steps.push(`<li class="${!needSpending && c.toEf >= c.efTarget ? 'done' : ''}"><strong>Emergency fund.</strong> ` +
      (needSpending
        ? `Fill in your budget above to size this — it's ${c.months} months of what you actually spend.`
        : `Keep <span class="amt">${money(c.efTarget)}</span> (${c.months} months of spending) in a high-yield savings account — not invested, and not touched unless something goes wrong. ` +
          (c.toEf >= c.efTarget ? `Your cash covers it.` : `Your cash covers ${money(c.toEf)} of it — build the rest first, before investing.`)) +
      `</li>`);

    if (c.debt > 0) {
      steps.push(`<li class="${c.toDebt >= c.debt ? 'done' : ''}"><strong>Pay off high-interest debt.</strong> ` +
        `Put <span class="amt">${money(c.toDebt)}</span> toward the ${money(c.debt)} you owe. At credit-card rates (often 20%+), paying it off beats what investing realistically earns.` +
        (c.toDebt < c.debt ? ` ${money(c.debt - c.toDebt)} will still be left — keep paying it down from your monthly leftover.` : '') + `</li>`);
    }

    if (c.shortTerm > 0) {
      steps.push(`<li class="${c.toShort >= c.shortTerm ? 'done' : ''}"><strong>Money you'll need within ~3 years.</strong> ` +
        `Set aside <span class="amt">${money(c.toShort)}</span> in savings, CDs, or Treasury bills — not stocks. A market drop right before you need it is the risk to avoid.</li>`);
    }

    const match = s.match || 'unsure';
    steps.push(`<li><strong>Grab any 401(k) match.</strong> ` +
      (match === 'yes' ? `Contribute at least enough from each paycheck to get the full match — it's an instant return you can't get anywhere else.`
        : match === 'no' ? `No match at your job — skip this step. A Roth IRA (next step) is often the first account people use instead.`
        : `Not sure? Ask HR or check your benefits portal — if there's a match, contribute at least enough to get all of it.`) + `</li>`);

    steps.push(`<li class="${c.longTerm > 0 ? '' : ''}"><strong>Invest for the long term.</strong> ` +
      (c.longTerm > 0
        ? `That leaves <span class="amt">${money(c.longTerm)}</span> you won't need for years — money that's losing ground in checking. A Roth IRA (if you're eligible) and then a regular brokerage account are the usual homes; broad, low-cost index funds are what most educators point beginners to.`
        : `Nothing left over for long-term investing yet — finishing the steps above comes first, and that's genuinely the right order.`) +
      (c.leftover > 0 ? ` Going forward, investing part of your ${money(c.leftover)} monthly leftover automatically is how most people build wealth.` : '') +
      `</li>`);

    let out = `<ol class="mp-steps">${steps.join('')}</ol>`;

    const monthly = Math.max(0, c.leftover);
    if (c.longTerm > 0 || monthly > 0) {
      const rows = [10, 20].map((y) => {
        const invested = futureValue(c.longTerm, monthly, ASSUMED_GROWTH_RATE, y);
        const sitting = c.longTerm + monthly * 12 * y;
        const sittingReal = sitting / Math.pow(1 + ASSUMED_INFLATION, y);
        return `<div class="mp-stat"><div class="k">In ${y} years</div>
          <div style="margin-top:6px">Invested: <strong>${money(invested)}</strong></div>
          <div class="mp-dim">Left in checking: ${money(sitting)} <span style="opacity:.8">(buys about what ${money(sittingReal)} does today)</span></div></div>`;
      }).join('');
      out += `<div class="mp-group">What waiting costs</div>
        <p class="mp-sub" style="margin-bottom:0">${c.longTerm > 0 ? money(c.longTerm) : 'Nothing'} now${monthly > 0 ? ` plus ${money(monthly)} a month` : ''}, invested vs. left in checking:</p>
        <div class="mp-compare">${rows}</div>
        <p class="mp-fine">Assumes ${pct(ASSUMED_GROWTH_RATE)} a year average growth, compounded monthly, and ${pct(ASSUMED_INFLATION)} a year inflation. These are simplifying assumptions, not a prediction — real returns vary a lot, and markets can fall sharply in any given year.</p>`;
    }
    return out;
  }

  window.mountMoneyPlanner = function (container) {
    if (!container || container.dataset.mpMounted) return;
    container.dataset.mpMounted = '1';
    if (!document.getElementById('mp-style')) {
      const style = document.createElement('style');
      style.id = 'mp-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const s = load();
    container.innerHTML = `<div class="mp">
      <div class="mp-card">
        <h3>1 · Your monthly budget</h3>
        <p class="mp-sub">Rough numbers are fine. Everything stays in this browser — nothing you type here is sent to our servers.</p>
        <div class="mp-grid">${field('income', 'Take-home pay / month (after tax)', '$4,000', s.income)}</div>
        <div class="mp-group">Needs</div>
        <div class="mp-grid">${NEEDS.map(([k, l]) => field(k, l, '$0', s[k])).join('')}</div>
        <div class="mp-group">Wants</div>
        <div class="mp-grid">${WANTS.map(([k, l]) => field(k, l, '$0', s[k])).join('')}</div>
        <div id="mp-budget-out"></div>
      </div>
      <div class="mp-card">
        <h3>2 · What to do with the cash you have</h3>
        <p class="mp-sub">The order most financial educators teach, sized to your numbers. General education and arithmetic — not personalized investment advice.</p>
        <div class="mp-grid">
          ${field('cash', 'Cash in checking + savings now', '$20,000', s.cash)}
          ${field('debt', 'Credit card / high-interest debt', '$0', s.debt)}
          ${field('shortTerm', 'Needed within ~3 years (car, move, etc.)', '$0', s.shortTerm)}
          <div class="mp-field"><label for="mp-efMonths">Emergency fund size</label>
            <select id="mp-efMonths" data-k="efMonths">
              ${[3, 4, 5, 6].map((m) => `<option value="${m}" ${String(s.efMonths || 6) === String(m) ? 'selected' : ''}>${m} months of spending</option>`).join('')}
            </select></div>
          <div class="mp-field"><label for="mp-match">401(k) match at work?</label>
            <select id="mp-match" data-k="match">
              ${[['unsure', 'Not sure'], ['yes', 'Yes'], ['no', 'No / no 401(k)']].map(([v, l]) => `<option value="${v}" ${(s.match || 'unsure') === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
        </div>
        <div id="mp-plan-out" style="margin-top:16px"></div>
      </div>
    </div>`;

    const update = () => {
      const state = {};
      container.querySelectorAll('[data-k]').forEach((el) => { state[el.dataset.k] = el.value; });
      save(state);
      const c = compute(state);
      container.querySelector('#mp-budget-out').innerHTML = renderBudgetResults(c);
      container.querySelector('#mp-plan-out').innerHTML = renderPlan(c, state);
    };
    container.addEventListener('input', update);
    container.addEventListener('change', update);
    update();
  };
})();
