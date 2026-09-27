// Status report page: renders GET /report (see src/core/report.ts). The DOM is
// built with node() + textContent only: no innerHTML with data.
// URL: report.html?project=<id>[&days=7|14|30][&tz=<IANA>]
(() => {
  const RANGES = [7, 14, 30];
  const RAG_LABEL = { green: 'Green', amber: 'Amber', red: 'Red', done: 'Done', grey: 'Grey' };
  const root = document.getElementById('report');

  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }
  const kids = (el, ...children) => {
    el.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  };

  // ---------- params ----------
  const params = new URLSearchParams(location.search);
  const project = params.get('project');
  const days = RANGES.includes(Number(params.get('days'))) ? Number(params.get('days')) : 7;
  const tz = params.get('tz') || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const dayKey = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
  const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  /** The report query: the last `days` days in tz (from the start of the first one to now). */
  const query = () => new URLSearchParams({ project, from: addDays(dayKey(Date.now()), -(days - 1)), tz }).toString();

  // ---------- formatters ----------
  function span(ms) {
    if (ms === null || ms === undefined) return 'n/a';
    const h = ms / 3_600_000;
    if (h < 1) return `${Math.round(ms / 60_000)}m`;
    if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}h`;
    const d = h / 24;
    return `${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)}d`;
  }
  const money = (usd) => `$${usd.toFixed(2)}`;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const pill = (rag, big) => node('span', `rp-pill ${rag}${big ? ' big' : ''}`, RAG_LABEL[rag] ?? rag);
  const where = (c) => [c.board, c.phase].filter(Boolean).join(' · ');

  function section(id, title, ...children) {
    const s = node('section');
    s.id = id;
    return kids(s, node('h2', '', title), ...children);
  }
  function list(items, render, empty) {
    if (!items.length) return node('p', 'rp-dim', empty);
    const ul = node('ul');
    for (const it of items) ul.append(render(it));
    return ul;
  }
  const cardItem = (c) => kids(node('li'), node('span', '', c.title), node('span', 'rp-meta', `  ${where(c)}`));

  // ---------- sections ----------
  function header(r) {
    const title = r.workspace ? `${r.workspace.name} / ${r.project.name}` : r.project.name;
    const seg = node('div', 'rp-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Range');
    for (const n of RANGES) {
      const b = node('button', 'rp-btn', `${n} days`);
      b.type = 'button';
      b.setAttribute('aria-current', String(n === days));
      b.onclick = () => {
        const u = new URL(location.href);
        u.searchParams.set('days', String(n));
        location.href = u.toString();
      };
      seg.append(b);
    }
    const copy = node('button', 'rp-btn', 'Copy as Markdown');
    copy.type = 'button';
    copy.id = 'rp-copy';
    const copied = node('span', 'rp-copied');
    copied.setAttribute('role', 'status');
    copy.onclick = async () => {
      try {
        const res = await fetch(`/report.md?${query()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await navigator.clipboard.writeText(await res.text());
        copied.textContent = 'Copied';
      } catch (err) {
        copied.textContent = `Copy failed: ${err.message}`;
      }
      setTimeout(() => (copied.textContent = ''), 2500);
    };
    const download = node('a', 'rp-btn', 'Download .md');
    download.id = 'rp-download';
    download.href = `/report.md?${query()}`;
    download.download = `status-report-${r.range.to_day}.md`;
    const print = node('button', 'rp-btn', 'Print');
    print.type = 'button';
    print.onclick = () => window.print();

    const head = node('header', 'rp-head');
    const titles = kids(
      node('div'),
      node('h1', '', `Status report: ${title}`),
      node('div', 'rp-sub', `${r.range.from_day} to ${r.range.to_day} · ${r.range.tz}`),
    );
    const overall = kids(node('div', 'rp-overall'), node('span', 'rp-dim', 'Overall'), pill(r.overall.rag, true), node('span', 'rp-meta', r.overall.reason));
    overall.id = 'rp-overall';
    overall.dataset.rag = r.overall.rag;
    const actions = kids(node('div', 'rp-actions'), seg, copy, download, print, copied);
    return kids(head, titles, node('div', 'rp-grow'), overall, actions);
  }

  function phases(r) {
    if (!r.phases.length) return section('rp-phases', 'Phases', node('p', 'rp-dim', 'No phases.'));
    const multi = r.boards.length > 1;
    const table = node('table', 'rp-table');
    const head = node('tr');
    for (const h of [...(multi ? ['Board'] : []), 'Phase', 'RAG', 'Target', 'Cards left', 'Reason']) {
      const th = node('th', '', h);
      th.scope = 'col';
      head.append(th);
    }
    table.append(kids(node('thead'), head));
    const body = node('tbody');
    for (const p of r.phases) {
      const tr = node('tr');
      tr.dataset.phase = p.id;
      tr.dataset.rag = p.rag;
      if (multi) tr.append(node('td', '', p.board));
      tr.append(node('td', '', p.title), kids(node('td'), pill(p.rag)), node('td', 'mono', p.target_date ?? '-'), node('td', 'mono', `${p.remaining}/${p.total}`));
      const reason = kids(node('td'), node('div', '', p.reason));
      const waits = [
        ...p.blockers.map((b) => `Blocked: ${b.title}${b.reason ? ` (${b.reason})` : ''}`),
        ...p.needs_you.map((n) => `Waiting on you: ${n.title}${n.reason ? ` (${n.reason})` : ''}`),
      ];
      for (const w of waits) reason.append(node('div', 'rp-waits', w));
      tr.append(reason);
      body.append(tr);
    }
    table.append(body);
    const unphased = r.blockers.filter((b) => b.phase_id === null);
    return section(
      'rp-phases',
      'Phases',
      table,
      unphased.length ? node('h3', '', 'Blockers (no phase)') : null,
      unphased.length ? list(unphased, (b) => kids(node('li'), node('span', '', b.title), node('span', 'rp-meta', `  ${b.board}${b.reason ? `: ${b.reason}` : ''}`)), '') : null,
    );
  }

  function shipped(r) {
    const s = section('rp-shipped', `Shipped (${r.shipped.total})`);
    if (!r.shipped.total) s.append(node('p', 'rp-dim', 'Nothing shipped in this range.'));
    for (const b of r.shipped.boards) {
      s.append(node('h3', '', b.board));
      const ul = node('ul');
      for (const p of b.phases) {
        const li = kids(node('li'), node('strong', '', p.phase ?? 'No phase'));
        li.append(list(p.cards, (c) => node('li', '', c.title), ''));
        ul.append(li);
      }
      s.append(ul);
    }
    return s;
  }

  function next(r) {
    return section(
      'rp-next',
      'Next',
      node('h3', '', `In progress (${r.next.in_progress.length})`),
      list(r.next.in_progress, cardItem, 'None.'),
      node('h3', '', `Queued (${r.next.queued.length})`),
      list(r.next.queued, cardItem, 'None.'),
      node('h3', '', `Milestones in the next 14 days (${r.next.milestones.length})`),
      list(r.next.milestones, (m) => kids(node('li'), node('span', 'mono', `${m.date}  `), node('span', '', m.title), node('span', 'rp-meta', `  ${where(m)}`)), 'None.'),
    );
  }

  function metricsSection(r) {
    const m = r.metrics;
    const tile = (label, value, note) => kids(node('div', 'rp-tile'), node('div', 'rp-tile-label', label), node('div', 'rp-tile-value', value), note ? node('div', 'rp-tile-note', note) : null);
    const tiles = kids(
      node('div', 'rp-tiles'),
      tile('Throughput', String(m.throughput), 'cards done'),
      tile('Cycle time p50', span(m.cycle_time.p50_ms), `p85 ${span(m.cycle_time.p85_ms)}`),
      tile('First-pass rate', m.first_pass.rate === null ? 'n/a' : `${Math.round(m.first_pass.rate * 100)}%`, plural(m.first_pass.reviewed, 'reviewed card')),
      tile(
        'Waiting on you',
        span(m.waiting_on_you.total_ms),
        m.waiting_on_you.now.count ? `${m.waiting_on_you.now.count} waiting now (longest ${span(m.waiting_on_you.now.longest_ms)})` : 'none waiting now',
      ),
      tile('Cost', money(m.cost.total_usd), `${plural(m.cost.runs, 'run')}${m.cost.placeholder_prices ? ' · placeholder prices' : ''}`),
    );
    const budgets = m.cost.budgets.length
      ? list(
          m.cost.budgets,
          (b) =>
            node(
              'li',
              '',
              `Budget ${b.phase}: ${money(b.actual_usd)} of ${money(b.budget_usd)}${b.projected_usd === null ? '' : `, projected ${money(b.projected_usd)}`} (${b.status === 'over' ? 'over budget' : b.status === 'projected_over' ? 'projected over budget' : 'on budget'})`,
            ),
          '',
        )
      : null;
    const caveats = m.cost.caveats.length ? kids(node('div', 'rp-caveats'), node('div', '', 'Cost caveats:'), list(m.cost.caveats, (c) => node('li', '', c), '')) : null;
    return section('rp-metrics', 'Metrics', tiles, budgets, caveats);
  }

  function risks(r) {
    const items = [
      ...r.risks.open.map((x) =>
        kids(node('li'), node('strong', 'mono', `${x.score}  `), node('span', '', x.title), node('span', 'rp-meta', `  ${x.status}${x.owner ? `, owner ${x.owner}` : ''}${x.mitigation ? `: ${x.mitigation}` : ''}`)),
      ),
      ...r.risks.closed.map((x) => node('li', 'rp-dim', `${x.status === 'occurred' ? 'Occurred' : 'Closed'}: ${x.title}`)),
    ];
    return section('rp-risks', 'Risks', list(items, (li) => li, 'No open risks.'));
  }

  function decisions(r) {
    const items = [
      ...r.decisions.made.map((d) =>
        kids(node('li'), node('span', 'mono', `${dayKey(d.decided_at)}  `), node('strong', '', d.title), node('span', '', `: ${d.decision}`), d.status === 'superseded' ? node('span', 'rp-meta', ' (since superseded)') : null),
      ),
      ...r.decisions.superseded.map((d) => node('li', 'rp-dim', `Superseded: ${d.title}`)),
    ];
    return section('rp-decisions', 'Decisions', list(items, (li) => li, 'No decisions in this range.'));
  }

  // ---------- load ----------
  async function load() {
    if (!project) {
      root.replaceChildren(node('p', 'rp-error', 'Missing ?project=<id> in the URL.'));
      root.removeAttribute('aria-busy');
      return;
    }
    try {
      const res = await fetch(`/report?${query()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      document.title = `Status report: ${body.project.name} (${body.range.from_day} to ${body.range.to_day})`;
      root.replaceChildren(header(body), phases(body), shipped(body), next(body), metricsSection(body), risks(body), decisions(body));
    } catch (err) {
      root.replaceChildren(node('p', 'rp-error', `Could not load the report: ${err.message}`));
    }
    root.removeAttribute('aria-busy');
  }
  load();
})();
