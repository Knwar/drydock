import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReport, fmtSpan, overallRag, phaseRag, reportMarkdown, type ReportInput, type ReportPhaseInput } from './report.js';
import type { ScheduleStatus } from './schedule.js';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 8, 26, 12); // Sat 2026-09-26 12:00 UTC
const FROM = Date.UTC(2026, 8, 20); // 7 days: 20th → 26th

const phase = (id: string, status: ScheduleStatus, extra: Partial<ReportPhaseInput> = {}): ReportPhaseInput => ({
  id,
  project_id: 'ws',
  title: `Phase ${id}`,
  phase_status: 'active',
  status,
  reason: `reason ${id}`,
  target_date: '2026-10-10',
  p50: null,
  p85: null,
  total: 4,
  remaining: 2,
  ...extra,
});

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    project: { id: 'ws', name: 'shop' },
    workspace: null,
    boards: [
      { id: 'ws', name: 'shop' },
      { id: 'web', name: 'web' },
    ],
    range: { from: FROM, to: NOW, tz: 'UTC' },
    today: '2026-09-26',
    generatedAt: NOW,
    phases: [phase('a', 'on_track'), phase('b', 'at_risk', { project_id: 'web' }), phase('c', 'done', { phase_status: 'done' })],
    milestones: [
      { id: 'm1', project_id: 'ws', title: 'Beta', date: '2026-10-01', phase_id: 'a' },
      { id: 'm2', project_id: 'ws', title: 'GA', date: '2026-10-20', phase_id: null }, // > 14 days out
      { id: 'm3', project_id: 'web', title: 'Past', date: '2026-09-20', phase_id: null },
    ],
    cards: [
      { id: 'k1', title: 'Shipped web', project_id: 'web', phase_id: 'b', lane: 'done', doneAt: NOW - 2 * D },
      { id: 'k2', title: 'Shipped ws a', project_id: 'ws', phase_id: 'a', lane: 'done', doneAt: NOW - D },
      { id: 'k3', title: 'Shipped ws none', project_id: 'ws', phase_id: null, lane: 'done', doneAt: NOW - 3 * D },
      { id: 'k4', title: 'Old', project_id: 'ws', phase_id: 'a', lane: 'done', doneAt: FROM - D },
      { id: 'k5', title: 'Queued one', project_id: 'web', phase_id: 'b', lane: 'queued', doneAt: null },
      { id: 'k6', title: 'Doing one', project_id: 'ws', phase_id: 'a', lane: 'in_progress', doneAt: null },
      { id: 'k7', title: 'Reviewing', project_id: 'ws', phase_id: 'a', lane: 'in_review', doneAt: null },
    ],
    blockers: [],
    needsYou: [{ project_id: 'ws', task_id: 'k6', reason: 'permission prompt', since: NOW - 2 * H }],
    flow: { throughput: 3, cycleP50: 5 * H, cycleP85: 2 * D },
    quality: { firstPassRate: 0.75, reviewed: 4 },
    wait: { needsYouMs: 3 * H, needsYouCount: 2 },
    cost: {
      total: 12.5,
      runs: 6,
      placeholder: true,
      caveats: ['output undercounts'],
      budgets: [
        { phase_id: 'a', title: 'Phase a', status: 'active', budget: 10, actual: 12, remainingCards: 2, projected: 15, overBudget: true, projectedOverBudget: true },
        { phase_id: 'b', title: 'Phase b', status: 'active', budget: null, actual: 3, remainingCards: 1, projected: null, overBudget: false, projectedOverBudget: false },
      ],
    },
    risks: [
      { id: 'r1', project_id: 'ws', title: 'Vendor | slip', description: null, likelihood: 4, impact: 5, score: 20, owner: 'ada', mitigation: 'second vendor', status: 'open', created_at: 0, updated_at: 0, closed_at: null, links: [], scope: 'own' },
      { id: 'r2', project_id: 'web', title: 'Flaky CI', description: null, likelihood: 2, impact: 2, score: 4, owner: null, mitigation: null, status: 'mitigating', created_at: 0, updated_at: 0, closed_at: null, links: [], scope: 'vertical' },
      { id: 'r3', project_id: 'ws', title: 'Closed in range', description: null, likelihood: 1, impact: 1, score: 1, owner: null, mitigation: null, status: 'closed', created_at: 0, updated_at: 0, closed_at: NOW - D, links: [], scope: 'own' },
      { id: 'r4', project_id: 'ws', title: 'Closed long ago', description: null, likelihood: 1, impact: 1, score: 1, owner: null, mitigation: null, status: 'occurred', created_at: 0, updated_at: 0, closed_at: FROM - D, links: [], scope: 'own' },
    ],
    decisions: [
      { id: 'd1', project_id: 'ws', title: 'Use Stripe', decision: 'Stripe for payments', rationale: null, decided_by: 'user', decided_at: NOW - D, status: 'active', superseded_by: null, created_at: 0, updated_at: NOW - D, links: [], scope: 'own' },
      { id: 'd0', project_id: 'ws', title: 'Use Adyen', decision: 'Adyen', rationale: null, decided_by: 'user', decided_at: FROM - 5 * D, status: 'superseded', superseded_by: 'd1', created_at: 0, updated_at: NOW - D, links: [], scope: 'own' },
      { id: 'dx', project_id: 'ws', title: 'Ancient', decision: 'x', rationale: null, decided_by: null, decided_at: FROM - 9 * D, status: 'active', superseded_by: null, created_at: 0, updated_at: 0, links: [], scope: 'own' },
    ],
    ...over,
  };
}

describe('report RAG rules', () => {
  it('maps each schedule status', () => {
    const want: Record<ScheduleStatus, string> = { on_track: 'green', at_risk: 'amber', late: 'red', complete: 'done', done: 'done', unknown: 'grey' };
    for (const [s, rag] of Object.entries(want)) assert.equal(phaseRag(s as ScheduleStatus, 0), rag, s);
  });
  it('an open blocker turns green amber, and nothing else', () => {
    assert.equal(phaseRag('on_track', 1), 'amber');
    assert.equal(phaseRag('at_risk', 2), 'amber');
    assert.equal(phaseRag('late', 1), 'red');
    assert.equal(phaseRag('unknown', 1), 'grey');
    assert.equal(phaseRag('complete', 1), 'done');
  });
  it('overall is the worst active phase (red > amber > grey > green > done)', () => {
    const p = (title: string, rag: any, phase_status: any = 'active') => ({ title, rag, phase_status });
    assert.deepEqual(overallRag([]), { rag: 'grey', reason: 'no active phase' });
    assert.equal(overallRag([p('x', 'red', 'done'), p('y', 'green')]).rag, 'green', 'non-active phases do not count');
    assert.equal(overallRag([p('x', 'green'), p('y', 'amber'), p('z', 'done')]).rag, 'amber');
    assert.equal(overallRag([p('x', 'green'), p('y', 'grey')]).rag, 'grey');
    assert.equal(overallRag([p('x', 'amber'), p('y', 'red'), p('z', 'grey')]).rag, 'red');
    assert.equal(overallRag([p('x', 'done'), p('y', 'green')]).rag, 'green');
    assert.equal(overallRag([p('x', 'done')]).rag, 'done');
    assert.deepEqual(overallRag([p('x', 'amber'), p('y', 'amber'), p('z', 'green')]), { rag: 'amber', reason: 'worst active phases: x, y' });
    assert.equal(overallRag([p('x', 'red', 'planned')]).reason, 'no active phase');
  });
});

describe('buildReport', () => {
  it('assembles phases, shipped, next, metrics, risks and decisions', () => {
    const r = buildReport(input());
    assert.deepEqual(
      r.phases.map((p) => [p.id, p.rag, p.board]),
      [
        ['a', 'green', 'shop'],
        ['b', 'amber', 'web'],
        ['c', 'done', 'shop'],
      ],
    );
    assert.deepEqual(r.overall, { rag: 'amber', reason: 'worst active phase: Phase b' });
    assert.deepEqual(r.phases[0].needs_you.map((n) => n.task_id), ['k6'], 'needs-you wait listed under its card’s phase');
    assert.equal(r.phases[0].rag, 'green', 'a needs-you wait does not change the colour');
    assert.deepEqual([r.range.from_day, r.range.to_day], ['2026-09-20', '2026-09-26']);

    // shipped: in range only, by board (scope order) then phase (phase order, no phase last)
    assert.equal(r.shipped.total, 3);
    assert.deepEqual(
      r.shipped.boards.map((b) => [b.board, b.phases.map((p) => [p.phase, p.cards.map((c) => c.id)])]),
      [
        ['shop', [['Phase a', ['k2']], [null, ['k3']]]],
        ['web', [['Phase b', ['k1']]]],
      ],
    );

    assert.deepEqual(r.next.queued.map((c) => [c.id, c.board, c.phase]), [['k5', 'web', 'Phase b']]);
    assert.deepEqual(r.next.in_progress.map((c) => c.id), ['k6']);
    assert.deepEqual(r.next.milestones.map((m) => [m.title, m.phase]), [['Beta', 'Phase a']], 'next 14 days, from today');

    assert.equal(r.metrics.throughput, 3);
    assert.deepEqual(r.metrics.cycle_time, { p50_ms: 5 * H, p85_ms: 2 * D });
    assert.deepEqual(r.metrics.first_pass, { rate: 0.75, reviewed: 4 });
    assert.deepEqual(r.metrics.waiting_on_you, { total_ms: 3 * H, count: 2, now: { count: 1, longest_ms: 2 * H } });
    assert.equal(r.metrics.cost.total_usd, 12.5);
    assert.deepEqual(r.metrics.cost.budgets.map((b) => [b.phase, b.status]), [['Phase a', 'over']], 'only phases with a budget');
    assert.match(r.metrics.cost.caveats[0], /Placeholder rates/, 'placeholder prices add the note');
    assert.equal(r.metrics.cost.caveats[1], 'output undercounts');

    assert.deepEqual(r.risks.open.map((x) => x.id), ['r1', 'r2'], 'open + mitigating, by score');
    assert.deepEqual(r.risks.closed.map((x) => x.id), ['r3'], 'closed/occurred in range');
    assert.deepEqual(r.decisions.made.map((d) => d.id), ['d1']);
    assert.deepEqual(r.decisions.superseded.map((d) => d.id), ['d0'], 'superseded in range');
  });

  it('an open blocker escalates a green phase and says why; unphased blockers are kept', () => {
    const r = buildReport(
      input({
        blockers: [
          { project_id: 'ws', task_id: 'k6', title: 'Doing one', phase_id: 'a', reason: 'Stripe or Adyen?', since: NOW - H },
          { project_id: 'ws', task_id: 'k9', title: 'Loose', phase_id: null, reason: null, since: NOW - H },
        ],
      }),
    );
    assert.equal(r.phases[0].rag, 'amber');
    assert.equal(r.phases[0].reason, 'reason a; 1 open blocker');
    assert.deepEqual(r.phases[0].blockers.map((b) => b.task_id), ['k6']);
    assert.deepEqual(r.blockers.map((b) => b.id), ['k6', 'k9']);
    assert.equal(r.overall.rag, 'amber');
  });

  it('late phase makes the overall red; no active phases → grey', () => {
    assert.equal(buildReport(input({ phases: [phase('a', 'late'), phase('b', 'on_track')] })).overall.rag, 'red');
    assert.equal(buildReport(input({ phases: [phase('c', 'done', { phase_status: 'done' })] })).overall.rag, 'grey');
  });
});

describe('reportMarkdown', () => {
  it('renders headings, a phase table and bullet lists', () => {
    const md = reportMarkdown(buildReport(input({ blockers: [{ project_id: 'ws', task_id: 'k6', title: 'Doing one', phase_id: 'a', reason: 'which | one', since: NOW - H }] })));
    assert.match(md, /^# Status report: shop\n/);
    assert.match(md, /\*\*2026-09-20 to 2026-09-26\*\* \(UTC\) · Overall: \*\*Amber\*\*/);
    assert.match(md, /\| Board \| Phase \| RAG \| Target \| Cards left \| Reason \|/);
    assert.match(md, /\| shop \| Phase a \| Amber \| 2026-10-10 \| 2\/4 \| reason a; 1 open blocker \|/);
    assert.match(md, /- Blocked in Phase a: Doing one \(which \| one\)/);
    assert.match(md, /- Waiting on you in Phase a: Doing one \(permission prompt\)/);
    assert.match(md, /## Shipped \(3\)\n\n### shop\n\n- \*\*Phase a\*\*\n {2}- Shipped ws a\n- \*\*No phase\*\*\n {2}- Shipped ws none/);
    assert.match(md, /\*\*Queued \(1\)\*\*\n\n- Queued one \[web · Phase b\]/);
    assert.match(md, /- 2026-10-01: Beta \[shop · Phase a\]/);
    assert.match(md, /- Cycle time: p50 5h, p85 2d/);
    assert.match(md, /- First-pass review rate: 75% \(4 reviewed cards\)/);
    assert.match(md, /- Cost: \$12\.50 over 6 runs \(placeholder prices\)/);
    assert.match(md, / {2}- Budget Phase a: \$12\.00 of \$10\.00, projected \$15\.00 \(over budget\)/);
    assert.match(md, /- \*\*20\*\* Vendor \| slip \(open, owner ada\): second vendor/);
    assert.match(md, /- Closed: Closed in range/);
    assert.match(md, /- 2026-09-25: \*\*Use Stripe\*\*: Stripe for payments/);
    assert.match(md, /- Superseded: Use Adyen/);
    assert.doesNotMatch(md, /\n{3}/);
    assert.ok(md.endsWith('\n'));
  });

  it('escapes pipes and newlines in table cells; empty sections say so', () => {
    const md = reportMarkdown(
      buildReport(
        input({
          boards: [{ id: 'ws', name: 'shop' }],
          phases: [phase('a', 'unknown', { title: 'A | B', reason: 'line one\nline two' })],
          cards: [],
          risks: [],
          decisions: [],
          milestones: [],
          needsYou: [],
        }),
      ),
    );
    assert.match(md, /\| Phase \| RAG \|/, 'single board: no Board column');
    assert.match(md, /\| A \\\| B \| Grey \| 2026-10-10 \| 2\/4 \| line one line two \|/);
    assert.match(md, /_Nothing shipped in this range._/);
    assert.match(md, /_No open risks._/);
    assert.match(md, /_No decisions in this range._/);
  });

  it('formats spans', () => {
    assert.deepEqual([fmtSpan(null), fmtSpan(30 * 60_000), fmtSpan(5.5 * H), fmtSpan(30 * H), fmtSpan(3.25 * D), fmtSpan(12 * D)], ['n/a', '30m', '5.5h', '30h', '3.3d', '12d']);
  });
});
