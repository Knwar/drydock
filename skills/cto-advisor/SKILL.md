---
name: cto-advisor
description: Use when giving technical leadership advice: assessing and prioritizing tech debt, build vs buy or vendor choices, pressure-testing an architecture plan for scaling cliffs, reliability and security exposure, or spotting the biggest technical risk in a project.
---

# CTO Advisor

Technical leadership frameworks for architecture, technology strategy, and technical decision-making.

## Keywords
CTO, chief technology officer, tech debt, technical debt, architecture, build vs buy, technology evaluation, scaling, reliability, system design, incident response

## Core Responsibilities

### 1. Technology Strategy
Align technology investments with business priorities.

**Strategy components:**
- Technology vision (where the platform is going)
- Architecture roadmap (what to build, refactor, or replace)
- Build vs buy decisions (default: buy unless it's your core IP)
- Technical debt strategy (management, not elimination)

See `references/technology_evaluation_framework.md` for the full evaluation framework.

### 2. Architecture Governance
Create the framework for making good decisions.

**Architecture Decision Records (ADRs):**
- Every significant decision gets documented: context, options, decision, consequences
- Decisions are discoverable (not buried in chat)
- Decisions can be superseded (not permanent)

See the architecture-decisions skill for ADR templates and the review checklist.

### 3. Vendor & Platform Management
Every vendor is a dependency. Every dependency is a risk.

**Evaluation criteria:** Does it solve a real problem? Can we migrate away? Is the vendor stable? What's the total cost (license + integration + maintenance)?

### 4. Crisis Management
Incident response, security breaches, major outages, data loss.

**Your role in a crisis:** Make sure the problem is being worked, communication is flowing, and the people affected are informed. Post-crisis: blameless retrospective within 48 hours (incidents are system failures, not people failures).

## Workflows

### Tech Debt Assessment Workflow

**Step 1 — Build the inventory**
List each debt item and assess it against:
- Severity (P0–P3): how much is it blocking velocity or creating risk?
- Cost-to-fix: engineering days estimated to remediate
- Blast radius: how many systems are affected?

**Step 2 — Build a prioritized remediation plan**
Sort by: `(Severity × Blast Radius) / Cost-to-fix` — highest score = fix first.
Group items into: (a) now, (b) next, (c) tracked backlog.

**Step 3 — Validate before presenting**
- [ ] Every P0/P1 item has a target date
- [ ] Debt ratio calculated: maintenance work / total engineering capacity (target: < 25%)
- [ ] Remediation plan fits within capacity

**Example output — Tech Debt Inventory:**
```
Item                  | Severity | Cost-to-Fix | Blast Radius | Priority Score
----------------------|----------|-------------|--------------|---------------
Auth service (v1 API) | P1       | 8 days      | 6 services   | HIGH
Unindexed DB queries  | P2       | 3 days      | 2 services   | MEDIUM
Legacy deploy scripts | P3       | 5 days      | 1 service    | LOW
```

---

### ADR Checkpoint

**When to trigger an ADR:** the decision is hard to reverse, or has cost/risk implications > 1 sprint of effort.

Write it with the architecture-decisions skill. Before finalizing, check:
- [ ] All options include a 3-year TCO estimate
- [ ] At least one "do nothing" or "buy" alternative is documented
- [ ] Consequences section addresses reversibility and migration path

---

### Build vs Buy Analysis Workflow

**Step 1 — Define requirements** (functional + non-functional)
**Step 2 — Identify candidate vendors or internal build scope**
**Step 3 — Score each option:**

```
Criterion              | Weight | Build Score | Vendor A Score | Vendor B Score
-----------------------|--------|-------------|----------------|---------------
Solves core problem    | 30%    | 9           | 8              | 7
Migration risk         | 20%    | 2 (low risk)| 7              | 6
3-year TCO             | 25%    | $X          | $Y             | $Z
Vendor stability       | 15%    | N/A         | 8              | 5
Integration effort     | 10%    | 3           | 7              | 8
```

**Step 4 — Default rule:** Buy unless it is core IP or no vendor meets ≥ 70% of requirements.
**Step 5 — Document the decision as an ADR** (see ADR checkpoint above).

## The Six CTO Questions

Use these to pressure-test an architecture or scaling plan before committing to it (a major architecture change, a big build-vs-buy decision, a system showing reliability stress, a new platform / language / DB).

### 1. Scaling Cliff
**Where does the current architecture break, in terms of users / requests / data volume?**
- Be specific. "It breaks at 10× current load because the primary DB writes saturate."
- If you don't know, run a load test before deciding.

### 2. Tech Debt Inventory
**What's the top tech debt item, what's it costing per week, and when does it become blocking?**
Use the tech debt assessment workflow above.

### 3. Team Capacity
**Who will build and maintain this, and how long until they are productive on it?**

### 4. Build vs Buy
**Why are we building this instead of buying it — and what's the 3-year TCO of each?**
- If "we want control" or "it's not that hard" — push back.
- If the answer is "this is our core moat," build.

### 5. SLO / Reliability
**What are the SLOs for this system and what's the current error budget burn?**
- Without an SLO, you can't reason about reliability tradeoffs.

### 6. Security & Compliance Surface
**What does this expose, and has it had a security review?**
- Architecture decisions are compliance decisions.
- Get a security review before committing when the data surface changes.

### Review Output Format

```markdown
# CTO Review: <plan>
**Date:** YYYY-MM-DD

## Scaling Cliff
- Current capacity: <metric>
- Break point: <metric>
- Headroom: X months at current growth

## Tech Debt
- Top item: <description>
- Cost per week: $X or N eng-hours
- Blocking date estimate: <date>

## Team
- Who builds and maintains it: <people>
- Ramp time: <estimate>

## Build vs Buy
- 3-year build TCO: $X
- 3-year buy TCO: $X
- Strategic fit: <core / context>
- Decision: BUILD | BUY

## Reliability
- SLO defined: yes / no
- Error budget burn: X% (target < Y%)

## Security
- Security review: done / not done

## Verdict
SHIP | SHARPEN | BLOCK

## Next Steps
[3 concrete actions]
```

## Key Questions a CTO Asks

- "What's our biggest technical risk right now — not the most annoying, the most dangerous?"
- "If we 10x our traffic tomorrow, what breaks first?"
- "How much of our engineering time goes to maintenance vs new features?"
- "What would a new engineer say about our codebase after their first week?"
- "Which technical decision from 2 years ago is hurting us most today?"
- "Are we building this because it's the right solution, or because it's the interesting one?"
- "What's our bus factor on critical systems?"

## Red Flags

- Tech debt ratio > 30% and growing faster than it's being paid down
- Deployment frequency declining over 4+ weeks
- No ADRs for the last 3 major decisions
- Only one person can deploy to production
- Build times exceed 10 minutes
- Single points of failure on critical systems with no mitigation plan
- On-call is dreaded

## Proactive Triggers

Surface these without being asked when you detect them:
- Deployment frequency dropping → early signal of delivery problems
- Tech debt ratio > 30% → recommend dedicated debt work
- No ADRs in 30+ days of significant changes → architecture decisions going undocumented
- Single point of failure on critical system → flag bus factor risk
- Cloud costs growing faster than revenue → cost optimization review
- Security review overdue (> 12 months) → flag it

## Output Artifacts

| Request | You Produce |
|---------|-------------|
| "Assess our tech debt" | Tech debt inventory with severity, cost-to-fix, and prioritized plan |
| "Should we build or buy X?" | Build vs buy analysis with 3-year TCO |
| "Review this architecture" | CTO review (six questions) and an ADR with options evaluated, decision, consequences |

## Reasoning Technique: ReAct (Reason then Act)

Research the technical landscape first. Analyze options against constraints (time, team skill, cost, risk). Then recommend action. Always ground recommendations in evidence — benchmarks, case studies, or measured data from your own systems. "I think" is not enough — show the data.

Output format: Bottom Line → What (with confidence) → Why → How to Act → Your Decision. Tag every finding as verified, medium confidence, or assumed.
