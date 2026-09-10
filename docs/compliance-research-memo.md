# Cardinal Finance AI — Regulatory Research Memo (Draft, Pre-Counsel)

**This is not legal advice.** This document was prepared by an AI assistant (Claude) to help the founder prepare for a real conversation with a securities attorney — it summarizes the legal tests that are publicly known to apply to products like this, and flags where Cardinal Finance AI's actual design sits relative to them. Nothing here should be treated as a clearance to charge real money, and nothing here substitutes for review by a licensed attorney in the relevant jurisdiction(s). Treat this as a briefing document, not a legal opinion.

**Bottom line up front:** before Cardinal Finance AI takes its first real (non-test-mode) dollar from a stranger, retain a securities attorney with fintech/RIA experience for a real review. This memo exists to make that conversation faster and cheaper, not to replace it.

---

## 1. The core question: is this "investment advice"?

The U.S. federal standard (Investment Advisers Act of 1940, and the three-part test the SEC and courts actually use — see *SEC v. Capital Gains Research Bureau*, 375 U.S. 180 (1963), and the SEC's own interpretive guidance) asks whether a person or company:

1. **Provides advice, or issues analyses/reports, about securities**
2. **Is in the business of doing so** (a regular part of their occupation, not a one-off)
3. **Receives compensation for it**

Mapped onto Cardinal Finance AI as it actually works today:

| Test | Cardinal Finance AI | Signal |
|---|---|---|
| Advice/analysis about securities | Yes — the entire product is AI + deterministic analysis of specific real holdings (tickers, quantities, cost basis) | **Strong yes** |
| In the business of it | Yes, if this becomes an ongoing paid product rather than a one-off tool | **Strong yes**, once monetized |
| Compensation | Yes — $29/month flat subscription | **Strong yes** |

All three prongs point toward "yes, this looks like investment advice" under the federal test. This doesn't mean the product is illegal or can't operate — plenty of legitimate registered and exempt advisers do exactly this kind of thing — but it does mean the analysis shouldn't be "we never say 'buy this'" and stop there. That mitigates *some* risk (see §3) but does not resolve the core "advice + business + compensation" test.

## 2. The exemption that does NOT clearly apply here: the "publisher's exemption"

There's a real, long-standing exemption for **bona fide publications of general and regular circulation** — think a financial newsletter or website giving general commentary that isn't tailored to any one subscriber's actual portfolio (the leading case is *Lowe v. SEC*, 472 U.S. 181 (1985)).

**This is the exemption people reach for first, and it's the one that's weakest for Cardinal Finance AI specifically.** The publisher's exemption depends on the advice being:
- **Impersonal** (not tailored to one person's specific financial situation)
- **General** (not analyzing one subscriber's actual real holdings)

Cardinal Finance AI's entire value proposition — the thing that makes it worth $29/month instead of free market commentary — is the *opposite* of impersonal: it connects real accounts, reads real positions, real cost basis, and generates analysis specific to that one person's actual portfolio. That's a meaningful factor cutting *against* the publisher's exemption applying cleanly, not for it. An attorney needs to weigh in on this specifically before anyone relies on it.

## 3. Design choices that are already good mitigations (keep and strengthen these)

None of these make registration unnecessary on their own, but they're the right instincts and worth highlighting to counsel as existing practice:

- **Never places, sizes, or times a trade** — every agent's system prompt explicitly forbids this, and no code path can execute an order. This is a real, structural fact, not just copy.
- **Deterministic math is separated from AI judgment** (`source: 'deterministic'` vs `'ai'` in the schema and UI) — reduces the "black box told me to do X" risk.
- **Confidence is capped** — AI-generated ideas never claim "high confidence" the way a calculation can.
- **`specialist_review_required` flags** on higher-stakes findings, nudging toward a human professional rather than positioning the AI as the final word.
- **Never fabricates numbers it doesn't have** (options strikes/premiums, etc.) — reduces a different kind of liability (bad information causing harm).

What's **missing** and should be treated as launch-blockers, not nice-to-haves:

- **No Terms of Service or Privacy Policy currently exist** on the live site. This is a gap independent of the investment-adviser question — no product should take payment without these, and an attorney will need to draft or review them anyway (this is a good one-stop task to bundle into the same engagement).
- **No explicit "this is not personalized investment advice from a registered adviser" disclosure** surfaced to the user at signup, on every AI output, and in the ToS. Even a well-mitigated product typically carries this kind of language; right now it's implied by product framing ("you place every trade yourself") but not stated in the specific regulatory terms a court or regulator would look for.

## 4. Registration: federal vs. state, and why this is genuinely jurisdiction-specific

- Advisers with **$100M+ in regulatory assets under management (AUM)** generally register with the SEC federally.
- Cardinal Finance AI doesn't manage assets at all (no discretion, no custody, no trading) — so the AUM-based federal threshold likely doesn't apply the way it would to a traditional adviser. But "furnishing advice for compensation without managing assets" is exactly the kind of adviser most states still regulate at the **state level**, and every state's rules differ.
- Many states have a **de minimis exemption** (commonly: advisers with a small number of clients in that state — often cited around 5 or fewer in a trailing 12 months — with no physical place of business there). NASAA (the state regulators' association) publishes model rules many states follow, but not all states adopt them identically.
- **This is the single most jurisdiction-dependent part of the whole question**, and exactly the kind of thing that needs a real attorney who tracks state-by-state variation — not something to guess at or extrapolate from one state's rule.

## 5. Concrete next steps, in order

1. **Retain a securities attorney with fintech/RIA experience** before switching Stripe out of test mode. Look for someone who has specifically worked with robo-advisers, fintech research tools, or newsletter/publisher-exemption cases — this is a specialized enough area that general business counsel may not be the right first call.
2. **Bring this memo and the actual product** to that conversation — screen-share the app, show the exact language every agent uses, and ask directly: "does the publisher's exemption apply to us, and if not, what's our registration posture?"
3. **Draft Terms of Service + Privacy Policy** as part of the same engagement — genuinely needed regardless of the investment-adviser question, and most securities attorneys either draft these or work with someone who does.
4. **Add explicit "not registered investment advice" disclosure** to: the signup flow, the footer of every page, and ideally a line on AI-generated recommendation cards themselves. Ask counsel for the specific language they want — regulators and courts pay attention to exact wording here, so don't freelance this part.
5. **Decide, with counsel, which path fits the business**: (a) restructure toward the publisher's exemption by making analysis less personalized (works against the core value prop, probably not the right call), (b) pursue state-level registration in the states with real user concentration, or (c) some hybrid — this is exactly the kind of strategic call that needs a real lawyer's judgment, not a default.
6. **Keep Stripe in test mode** until that conversation happens. Everything else about the product — the desk, Terminal, Learn to Invest, billing infrastructure — can keep being built and tested in parallel; only the "take real money from strangers" step needs to wait on this.

---

*Prepared as a research aid by Claude (Anthropic) at the founder's request. Contains no confidential attorney work product, is not privileged, and is not a substitute for independent legal judgment by a licensed attorney.*
