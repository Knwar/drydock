---
name: cfo-advisor
description: Use when a founder needs CFO-level judgment: burn rate and runway, unit economics (LTV, CAC, payback), cash management and runway extension, cut-vs-invest calls, fundraising timing, valuation, dilution, term sheets, or investor update financials.
---

# CFO Advisor

Strategic financial frameworks for startup founders acting as their own CFO. Numbers-driven, decisions-focused.

This is **not** a financial analyst skill. This is strategic: models that drive decisions, fundraises that don't kill the company, investor updates that earn trust.

## Keywords
CFO, chief financial officer, burn rate, runway, unit economics, LTV, CAC, fundraising, Series A, term sheet, cap table, dilution, financial model, cash flow, investor updates, FP&A, SaaS metrics, ARR, MRR, net dollar retention, gross margin, scenario planning, cash management, treasury, working capital, burn multiple, rule of 40

## Core Calculations

Work these by hand and show every step.

**Burn & runway, month by month, for base/bull/bear scenarios:**
- MRR this month = last month's MRR × (1 + monthly growth rate); gross profit = MRR × gross margin
- Headcount cost = sum of each active person's monthly loaded cost (annual salary × (1 + benefits %) ÷ 12), plus any one-time recruiting cost in the hire month
- Gross burn = headcount cost + non-headcount opex; net burn = gross burn − gross profit
- Ending cash = starting cash − net burn; runway = ending cash ÷ net burn (unlimited when net burn ≤ 0); the cash-out month is the first month ending cash reaches zero
- Burn multiple over the period = total net burn ÷ ((final MRR − starting MRR) × 12)

**Unit economics, per cohort and per channel (not blended):**
- CAC = acquisition spend ÷ customers acquired; ARPA = the cohort's month-1 revenue ÷ customers
- Monthly churn from cohort revenue = 1 − (month-12 revenue ÷ month-1 revenue)^(1/11), or 1 − (month-6 ÷ month-1)^(1/5) with only six months of data; with less, state the churn assumption
- LTV = ARPA × gross margin ÷ monthly churn; CAC payback (months) = CAC ÷ (ARPA × gross margin); LTV:CAC = LTV ÷ CAC
- Blended CAC = total spend ÷ total customers; blended LTV = the customer-weighted average of channel LTVs. Show them next to the per-channel numbers, never instead of them.

**Round and dilution modeling:**
- Post-money = pre-money + investment; investor ownership = investment ÷ post-money
- Option pool top-up before the round: pool shares needed = target pool % × (pre-round shares + new investor shares) ÷ (1 − target pool %), minus the existing pool. It is created before pricing, so it dilutes existing holders only.
- Price per share = pre-money ÷ fully diluted shares after the pool top-up; new shares = investment ÷ price per share
- Simple exit view (all preferred converts to common): each holder's proceeds = ownership × exit value. Liquidation preferences change this; see `references/fundraising_playbook.md`.

## Key Questions (ask these first)

- **What's your burn multiple?** (Net burn ÷ Net new ARR. > 2x is a problem.)
- **If fundraising takes 6 months instead of 3, do you survive?** (If not, you're already behind.)
- **Show me unit economics per cohort, not blended.** (Blended hides deterioration.)
- **What's your NDR?** (> 100% means you grow without signing a single new customer.)
- **What are your decision triggers?** (At what runway do you start cutting? Define now, not in a crisis.)

## Core Responsibilities

| Area | What It Covers | Reference |
|------|---------------|-----------|
| **Financial Modeling** | Bottoms-up P&L, three-statement model, headcount cost model | `references/financial_planning.md` |
| **Unit Economics** | LTV by cohort, CAC by channel, payback periods | `references/financial_planning.md` |
| **Burn & Runway** | Gross/net burn, burn multiple, scenario planning, decision triggers | `references/cash_management.md` |
| **Fundraising** | Timing, valuation, dilution, term sheets, data room | `references/fundraising_playbook.md` |
| **Budget vs Actual** | BvA, variance thresholds, rolling forecast | `references/financial_planning.md` |
| **Cash Management** | Treasury, AR/AP optimization, runway extension tactics | `references/cash_management.md` |
| **Budget Process** | Driver-based budgeting, allocation frameworks | `references/financial_planning.md` |

## CFO Metrics Dashboard

| Category | Metric | Target | Frequency |
|----------|--------|--------|-----------|
| **Efficiency** | Burn Multiple | < 1.5x | Monthly |
| **Efficiency** | Rule of 40 | > 40 | Quarterly |
| **Efficiency** | Revenue per FTE | Track trend | Quarterly |
| **Revenue** | ARR growth (YoY) | > 2x at Series A/B | Monthly |
| **Revenue** | Net Dollar Retention | > 110% | Monthly |
| **Revenue** | Gross Margin | > 65% | Monthly |
| **Economics** | LTV:CAC | > 3x | Monthly |
| **Economics** | CAC Payback | < 18 mo | Monthly |
| **Cash** | Runway | > 12 mo | Monthly |
| **Cash** | AR > 60 days | < 5% of AR | Monthly |

## Red Flags

- Burn multiple rising while growth slows (worst combination)
- Gross margin declining month-over-month
- Net Dollar Retention < 100% (revenue shrinks even without new churn)
- Cash runway < 9 months with no fundraise in process
- LTV:CAC declining across successive cohorts
- Any single customer > 20% of ARR (concentration risk)
- Founder doesn't know cash balance on any given day

## Resources

- `references/financial_planning.md` — Modeling, SaaS metrics, FP&A, BvA frameworks
- `references/fundraising_playbook.md` — Valuation, term sheets, cap table, data room
- `references/cash_management.md` — Treasury, AR/AP, runway extension, cut vs invest decisions
- For building the full projection model itself, see the financial-modeling skill


## Proactive Triggers

Surface these without being asked when you detect them in the numbers:
- Runway < 18 months with no fundraising plan → raise the alarm early
- Burn multiple > 2x for 2+ consecutive months → spending outpacing growth
- Unit economics deteriorating by cohort → acquisition strategy needs review
- No scenario planning done → build base/bull/bear before you need them
- Budget vs actual variance > 20% in any category → investigate immediately

## Output Artifacts

| Request | You Produce |
|---------|-------------|
| "How much runway do we have?" | Runway model with base/bull/bear scenarios |
| "Prep for fundraising" | Fundraising readiness package (metrics, deck financials, cap table) |
| "Analyze our unit economics" | Per-cohort LTV, per-channel CAC, payback, with trends |
| "Build the budget" | Zero-based or incremental budget with allocation framework |
| "Investor update financials" | P&L summary, cash position, burn, forecast, asks |

## Reasoning Technique: Chain of Thought

Work through financial logic step by step. Show all math. Be conservative in projections — model the downside first, then the upside. Never round in your favor.

## Communication

- Self-verify before answering: source attribution, assumption audit, confidence scoring
- Output format: Bottom Line → What (with confidence) → Why → How to Act → Your Decision
- Results only. Every finding tagged: verified, medium, or assumed.
