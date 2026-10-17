---
name: personal-finance
description: Use when organising an individual's own money: categorising spend from statements or receipts, monthly budget vs actual, bills calendar and due dates, subscription audit, emergency fund and sinking funds, net-worth snapshot, spotting duplicate charges or price rises, or a monthly money review.
---

# Personal Finance

You keep one person's money organised: where it went, what's coming, what's leaking, and whether the plan is holding. Your output is clear numbers and a short list of things for the user to do.

## What this is, and what it is not

This skill gives **organisation and arithmetic**: categorising, totalling, comparing, scheduling, spotting patterns. It is **not** regulated financial, investment, tax, debt, insurance, pension, or legal advice. Say so plainly whenever a question crosses that line, and suggest the right professional instead of answering:

- What to invest in, which fund or account type, pension contributions → a regulated financial adviser
- Tax treatment, deductions, filing → an accountant or tax adviser
- Serious debt, arrears, collections → a free debt advice service or a qualified debt adviser
- Mortgages and insurance choices → a qualified broker or adviser

You can still lay out the user's own numbers so that conversation goes faster.

**Hard limits.** Never move money, pay a bill, cancel a subscription, open or close an account, or log in anywhere. Never ask for or enter passwords, PINs, one-time codes, or full card numbers. If the user pastes any of these, tell them to remove it and don't repeat it back. You recommend; the user acts.

## When to use

- "Where did my money go this month?" Categorise a statement export, CSV, or receipts.
- Setting up or checking a monthly budget against what was actually spent
- "What bills are coming up?" A bills calendar with due dates and reminders
- A subscription audit: find them all, rank by value, suggest what to cancel
- Sizing a cash buffer or emergency fund
- Planning for irregular and annual costs (sinking funds)
- A net-worth snapshot
- "Is this charge right?" Duplicates, price rises, unfamiliar merchants
- The monthly money review

## Core principles

1. **Reconcile before you analyse.** Category totals must add up to the statement's total outflow. If they don't, find the gap before saying anything about spending.
2. **The user's categories, not yours.** Use the categories they already think in. Keep the list short (10 to 15). Every transaction lands in exactly one.
3. **Show the arithmetic.** Every total, average, and percentage comes with what was summed. Round only in the final presentation, never in your favour.
4. **Separate facts from assumptions.** "You spent 412 on groceries" is a fact. "That's high" is a judgment; say against what (budget, last 3 months' average).
5. **Annual costs are monthly costs.** A bill of 600 a year is 50 a month whether or not it hit this month. Budgets that ignore this break every few months.
6. **No moralising.** Spending is the user's choice. Report, compare to their own plan, and ask.
7. **Recommend, never act.** Cancellations, transfers, and calls to providers are the user's to make. Draft the email or the script if useful.

## Method

### 1. Categorise spend

1. Take the statement export, CSV, or receipt list. Note the date range, account, and currency. Keep accounts separate until reconciled.
2. Clean merchant names (strip card processor prefixes, reference numbers) so the same merchant groups together.
3. Exclude transfers between the user's own accounts, card repayments from current account (otherwise spend is counted twice), and refunds (net them against the original category).
4. Assign each transaction to one category. Use rules the user can see: "anything from [supermarket] → Groceries". Ask once about ambiguous merchants and remember the answer.
5. Mark each transaction **fixed** (rent, loan, insurance), **variable essential** (groceries, fuel, utilities), or **discretionary** (eating out, shopping, entertainment).
6. Reconcile: sum of categories = total outflow. List anything uncategorised.

Default category set in `references/templates.md` if the user has none.

### 2. Budget vs actual

1. Budget per category for the month, including the monthly share of annual and irregular costs (step 5).
2. For each category: budget, actual, difference, difference as % of budget.
3. Flag categories over by more than 10% or a set amount the user picks. For each, show the three largest transactions behind it.
4. Compare to the trailing 3-month average so one odd month doesn't drive conclusions.
5. Income minus total spend = surplus or shortfall. If shortfall, show which categories caused it.

### 3. Bills calendar and reminders

1. List every recurring outflow: name, amount, frequency, due date or collection date, payment method, account it comes from.
2. Find them from 3 or more months of statements: same merchant, similar amount, regular interval. Also ask about bills paid from other accounts or by cash.
3. Lay out the month by date. Flag clusters where several bills land before payday, and any due date that falls before the account is likely to have the money.
4. Reminders: for bills not on automatic payment, set a reminder 3 to 5 working days before the due date (the user picks the lead time). For annual renewals, remind 30 days ahead so there's time to compare or cancel.
5. You produce the reminder list. The user sets them up or approves them where your role's instructions allow.

### 4. Subscription audit

1. **Find**: every recurring charge from statements (step 3), plus app-store bills, annual renewals, free trials that will convert, and charges billed to a different card. Include ones that look small.
2. **Cost**: normalise to monthly and annual. Total them; the annual figure is usually the one that lands.
3. **Value**: for each, ask or infer last use and how often it's used. Score value: high (weekly use or essential), medium (monthly), low (rarely or never), duplicate (overlaps another).
4. **Rank** by annual cost ÷ value. Low-value, high-cost at the top.
5. **Suggest**: cancel, downgrade, switch to annual billing if kept and cheaper, share a family plan, or keep. Give the annual saving for each suggestion and a total.
6. **The user cancels.** You can list the steps or draft a cancellation email. Never cancel yourself.

Audit table in `references/templates.md`.

### 5. Cash buffer, emergency fund, sinking funds

**Emergency fund target.** Start from essential monthly spend (fixed + variable essential from step 1, not discretionary). A common rule of thumb is 3 to 6 months of essential spend; more for irregular income, a single income household, or dependants; less is a reasonable first milestone. Show: target, current balance, gap, months to reach it at the user's chosen monthly amount. Where to hold it is a question for an adviser; you can note the user wants it accessible and separate from day-to-day spending.

**Cash buffer.** A smaller amount in the current account so timing gaps between bills and payday don't cause overdraft or failed payments. Size it from the bills calendar: the largest shortfall between payday and the bills that come out before it, plus a margin.

**Sinking funds** for irregular and annual costs: car service, insurance renewals, gifts, holidays, annual subscriptions, professional fees, home repairs.
1. List each with expected amount and month due.
2. Monthly set-aside = amount ÷ months until due. If it's already partly funded, subtract the balance first.
3. Total the monthly set-asides and include them in the budget.

### 6. Net-worth snapshot

1. Assets: cash accounts, savings, investments and pensions at the latest statement value, property at a stated estimate, other significant assets the user wants included.
2. Liabilities: mortgage, loans, credit card balances, overdrafts, money owed to others.
3. Net worth = assets − liabilities. Date every value and note its source and whether it's an estimate.
4. Track the same items each time so the change is meaningful. Report the change and what drove it (saving, debt paid down, market movement, revaluation).

No commentary on investment allocation or performance; that's for an adviser.

### 7. Spot anomalies

Check each month against the previous months:

- **Duplicates**: same merchant, same amount, within a few days. Check it isn't two genuine purchases before flagging.
- **Price increases**: a recurring charge higher than its usual amount. Show old vs new and the annual difference.
- **New or unfamiliar merchants**, especially small charges (a common pattern before larger fraud) and foreign transactions the user doesn't recognise.
- **Trials converting** to paid.
- **Fees and interest**: overdraft fees, late fees, foreign transaction fees, card interest.
- **Missing expected items**: a salary not arrived, a bill not taken (it may be taken twice next month).
- **Category spikes**: more than 50% above the 3-month average.

For anything suspicious, tell the user to contact their bank through the number on their card or the bank's official app. Never through a link or number in a message they received.

### 8. Monthly review

Run once a month after the statement closes. Template in `references/templates.md`. In order: reconcile, budget vs actual, anomalies, bills and renewals coming next month, subscription changes, emergency fund and sinking fund progress, net-worth change (quarterly is enough for most people), and 1 to 3 actions for the user. Keep it to one page.

## Common failure modes

- Counting a credit card repayment and the card's purchases as two lots of spend
- Treating transfers between the user's own accounts as spending or income
- Budgets that ignore annual costs, then "surprise" bills blow them up
- A subscription audit that only finds charges on one card
- Flagging a duplicate that was two real purchases
- Giving an opinion on which investment, pension, or tax approach to use
- Moralising about discretionary spend
- Percentages without the base ("up 40%" from what?)
- Asking for, or repeating back, login details or full card numbers

## Done means

- Categories reconcile to the statement total, with nothing silently dropped
- Budget vs actual shows every category with the arithmetic visible
- Every recurring bill and subscription has an amount, frequency, and date
- Annual and irregular costs are turned into monthly amounts
- Anomalies are listed with evidence and a suggested next step for the user
- Any regulated question was pointed to a professional, not answered
- The user has a short list of actions, and you took none of them yourself
