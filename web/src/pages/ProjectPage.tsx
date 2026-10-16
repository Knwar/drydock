import { useEffect, useMemo, useState } from 'react';
import { Diagram, Legend, type Element, type Relation } from '../components/Diagram';
import { Icon } from '../components/Icon';
import { StageSteps } from '../components/Shell';
import { api, useApi } from '../lib/api';
import { Markdown } from '../lib/md';
import { go, href, navigate } from '../lib/router';
import type { Role } from '../lib/types';

const TABS = [
  ['', 'Overview'],
  ['requirements', 'Requirements'],
  ['design', 'System design'],
  ['board', 'Board'],
  ['roles', 'Roles'],
  ['agents', 'Live agents'],
  ['docs', 'Docs'],
] as const;

const STAGE_NAMES: Record<string, string> = { idea: 'Idea', create: 'Create', requirements: 'Requirements', design: 'Design', plan: 'Plan', build: 'Build' };

interface Detail {
  id: string;
  name: string;
  root: string;
  slug: string;
  vault: string;
  stage: string;
  description: string | null;
  verticals: { id: string; name: string; done: number; total: number }[];
  phase: { index: number; count: number; title: string } | null;
  phases: { id: string; title: string; goal: string | null; status: string }[];
  cards: { done: number; total: number };
  liveAgents: number;
  blocked: number;
  inReview: number;
  channels: { id: string; name: string }[];
  decisions: { id: number; title: string; why: string | null; role_id: string | null; created_at: number }[];
}

const refresh = (id: string) => (m: any) =>
  (['brain_project', 'requirements', 'design', 'decisions', 'conversations'].includes(m?.type) && (!m.project_id || m.project_id === id)) || ['card', 'phases', 'card_removed'].includes(m?.type);

const ROLE_LABEL: Record<string, string> = { architect: 'Architect', pm: 'PM', cto: 'CTO' };

function Gate({ p, openConversation }: { p: Detail; openConversation: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<string | null>(null);
  const run = async (path: string) => {
    setBusy(true);
    setError(null);
    setNeeds(null);
    try {
      const res = await fetch(path, { method: 'POST' });
      const r = await res.json();
      if (res.status === 409 && r.needs_role) {
        setNeeds(r.needs_role);
        setError(r.error);
        return;
      }
      if (!res.ok) throw new Error(r.error ?? res.statusText);
      if (r?.channel) openConversation(r.channel);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addAndRun = async (path: string) => {
    await api('/api/roles', { body: { template: needs } });
    await run(path);
  };
  const action =
    p.stage === 'requirements'
      ? { label: 'Mark requirements final', hint: 'The Architect starts the system design.', path: `/api/projects/${p.id}/requirements/final` }
      : p.stage === 'design'
        ? { label: 'Finalise design', hint: 'Creates the verticals and asks the PM for a roadmap.', path: `/api/projects/${p.id}/design/final` }
        : p.stage === 'plan'
          ? { label: 'Approve roadmap and start building', hint: p.phases.length ? `${p.phases.length} phases proposed.` : 'Waiting for the PM to propose phases.', path: `/api/projects/${p.id}/start`, disabled: !p.phases.length }
          : null;
  if (!action) return null;
  return (
    <div className="gate">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>Next gate</span>
        <span className="muted" style={{ fontSize: 12 }}>{action.hint}</span>
        {error && <span className={needs ? 'muted' : 'error'} style={needs ? { fontSize: 12, color: 'var(--a-fg)' } : undefined}>{error}</span>}
      </div>
      {needs ? (
        <button className="btn primary" disabled={busy} onClick={() => addAndRun(action.path)}>
          Add {ROLE_LABEL[needs] ?? needs} and continue
        </button>
      ) : (
        <button className="btn primary" disabled={busy || action.disabled} onClick={() => run(action.path)}>
          {busy ? 'Working…' : action.label}
        </button>
      )}
    </div>
  );
}

function Overview({ p, openConversation }: { p: Detail; openConversation: (id: string) => void }) {
  const kpis = [
    { label: 'Stage', value: STAGE_NAMES[p.stage], sub: p.description ?? '' },
    { label: 'Current phase', value: p.phase ? `${p.phase.index} of ${p.phase.count}` : '—', sub: p.phase?.title ?? 'Not planned yet' },
    { label: 'Cards this phase', value: p.cards.total ? `${p.cards.done} / ${p.cards.total}` : '—', sub: `${p.inReview} in review · ${p.blocked} blocked` },
    { label: 'Live agents', value: String(p.liveAgents), sub: p.channels.length ? `${p.channels.length} project channels` : 'No project channels yet' },
  ];
  return (
    <>
      <div className="kpis">
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <div className="muted" style={{ fontSize: 12 }}>{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.sub}</div>
          </div>
        ))}
      </div>
      <div className="row">
        <div className="grow2" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="panel">
            <h2>Roadmap</h2>
            {p.phases.length ? (
              <div className="phases">
                {p.phases.map((ph, i) => (
                  <div key={ph.id} className={`phase phase-${ph.status}`}>
                    <span className="mono muted" style={{ fontSize: 11 }}>P{i + 1} · {ph.status}</span>
                    <strong style={{ fontSize: 13 }}>{ph.title}</strong>
                    {ph.goal && <span className="muted" style={{ fontSize: 11.5 }}>{ph.goal.slice(0, 110)}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">No roadmap yet. The PM proposes phases after the design is final.</div>
            )}
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2>Verticals</h2>
              <a className="btn sm" href={href(`/project/${p.id}/design`)} onClick={go(`/project/${p.id}/design`)}>Open system design</a>
            </div>
            {p.verticals.length ? (
              <div className="grid-cards">
                {p.verticals.map((v) => {
                  const pct = v.total ? Math.round((v.done / v.total) * 100) : 0;
                  return (
                    <div key={v.id} className="mini-card">
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{v.name}</strong><span className="mono">{pct}%</span></div>
                      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
                      <span className="muted" style={{ fontSize: 12 }}>{v.done}/{v.total} cards done</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty">Verticals are created from the system design when you finalise it.</div>
            )}
          </section>
        </div>
        <div className="grow1" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="panel">
            <h2>Recent decisions</h2>
            {p.decisions.length ? (
              p.decisions.map((d) => (
                <div key={d.id} className="list-row">
                  <Icon name="check" style={{ color: 'var(--g-fg)', flex: '0 0 16px', marginTop: 2 }} />
                  <div><div style={{ fontWeight: 600, fontSize: 13 }}>{d.title}</div><div className="muted" style={{ fontSize: 12 }}>{new Date(d.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}{d.why ? ` · ${d.why.slice(0, 80)}` : ''}</div></div>
                </div>
              ))
            ) : (
              <div className="muted" style={{ fontSize: 13 }}>Decisions agreed in chat appear here.</div>
            )}
          </section>
          <section className="panel">
            <h2>Channels</h2>
            {p.channels.length ? p.channels.map((c) => (
              <button key={c.id} className="nav-row" onClick={() => openConversation(c.id)}><span className="muted">#</span><span className="label">{c.name}</span></button>
            )) : <div className="muted" style={{ fontSize: 13 }}>Created as the project moves through its stages.</div>}
          </section>
        </div>
      </div>
    </>
  );
}

function Requirements({ p }: { p: Detail }) {
  const versions = useApi<{ version: number; markdown: string; author: string | null; final: number; created_at: number }[]>(`/api/projects/${p.id}/requirements`, (m) => m?.type === 'requirements');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = versions.data ?? [];
  const cur = list[0];
  const save = async () => {
    try {
      await api(`/api/projects/${p.id}/requirements`, { body: { markdown: editing } });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      {cur?.final ? (
        <div className="banner t-g">
          <Icon name="check" />
          <span style={{ flex: 1 }}><strong>Requirements v{cur.version} are final.</strong> The design and roadmap are built from this version.</span>
          <button className="btn sm" onClick={() => api(`/api/projects/${p.id}/requirements/reopen`, { method: 'POST' })}>Reopen</button>
        </div>
      ) : (
        <div className="banner t-b">
          <span style={{ flex: 1 }}>Discuss the requirements with the main agent in chat; it keeps this document updated. You can also edit it directly.</span>
        </div>
      )}
      <div className="row">
        <article className="panel grow2" style={{ padding: '22px 26px' }}>
          <div className="panel-head">
            <span className="mono muted" style={{ fontSize: 12 }}>vault/projects/{p.slug}/requirements/current.md{cur ? ` · v${cur.version}` : ''}</span>
            {!cur?.final && editing === null && cur && <button className="btn sm" onClick={() => setEditing(cur.markdown)}>Edit</button>}
          </div>
          {editing !== null ? (
            <>
              <textarea className="input mono" style={{ minHeight: 420, fontSize: 12.5 }} value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Requirements markdown" />
              {error && <div className="error">{error}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={save}>Save as v{(cur?.version ?? 0) + 1}</button>
                <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </>
          ) : cur ? (
            <div className="doc"><Markdown text={cur.markdown} /></div>
          ) : (
            <div className="empty">No requirements yet.</div>
          )}
        </article>
        <aside className="panel grow1">
          <h2>Versions</h2>
          {list.map((v) => (
            <div key={v.version} className="list-row">
              <span className="mono" style={{ fontWeight: 700, flex: '0 0 28px' }}>v{v.version}</span>
              <span className="muted" style={{ fontSize: 12 }}>{new Date(v.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {v.author ?? 'user'}{v.final ? ' · final' : ''}</span>
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}

function SystemDesign({ p, focus, openConversation }: { p: Detail; focus: string | null; openConversation: (id: string) => void }) {
  const design = useApi<{ elements: Element[]; relations: Relation[]; finalVersion: number | null }>(`/api/projects/${p.id}/design`, (m) => m?.type === 'design' && m.project_id === p.id);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [focus]);
  const elements = design.data?.elements ?? [];
  const relations = design.data?.relations ?? [];
  const byId = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements]);
  const crumbs: Element[] = [];
  for (let cur = focus ? byId.get(focus) : undefined; cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) crumbs.unshift(cur);
  const sel = selected ? byId.get(selected) : null;
  const base = `/project/${p.id}/design`;
  const designChannel = p.channels.find((c) => c.name.endsWith('-design'));
  const level = focus ? (byId.get(focus)?.kind === 'container' ? 'Component view' : 'Detail view') : 'Container view';

  if (!design.data) return null;
  if (!elements.length)
    return (
      <div className="empty" style={{ padding: 36 }}>
        {p.stage === 'requirements' ? 'The system design starts when you mark the requirements final.' : 'The Architect has not added anything yet. Follow along in the design channel.'}
        {designChannel && <div style={{ marginTop: 10 }}><button className="btn sm" onClick={() => openConversation(designChannel.id)}>Open #{designChannel.name}</button></div>}
      </div>
    );
  const rels = sel ? relations.filter((r) => r.source === sel.id || r.target === sel.id) : [];
  return (
    <>
      <div className="design-bar">
        <nav aria-label="Breadcrumb" className="crumbs">
          <span className="muted">{p.name}</span><span className="muted">›</span>
          {focus ? <a href={href(base)} onClick={go(base)}>Container view</a> : <strong>Container view</strong>}
          {crumbs.map((c, i) => (
            <span key={c.id} style={{ display: 'contents' }}>
              <span className="muted">›</span>
              {i === crumbs.length - 1 ? <strong>{c.name}</strong> : <a href={href(`${base}/${c.id}`)} onClick={go(`${base}/${c.id}`)}>{c.name}</a>}
            </span>
          ))}
        </nav>
        <span className="pill t-n" style={{ marginLeft: 'auto' }}>{design.data.finalVersion ? `v${design.data.finalVersion} final` : 'draft'}</span>
        {designChannel && <button className="btn sm primary" onClick={() => openConversation(designChannel.id)}>Discuss with Architect</button>}
      </div>
      <div className="row">
        <section className="panel" style={{ flex: '999 1 480px', minWidth: 0, padding: 0, gap: 0 }}>
          <div style={{ padding: '14px 18px 0' }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{level} — {focus ? byId.get(focus)?.name : p.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>C4 · generated from the design model · {elements.length} elements, {relations.length} relations</div>
          </div>
          <Diagram elements={elements} relations={relations} focus={focus} selected={selected} onSelect={setSelected} onDrill={(id) => navigate(`${base}/${id}`)} focusName={focus ? byId.get(focus)?.name ?? '' : p.name} />
          <Legend />
        </section>
        <aside className="panel" style={{ flex: '1 1 240px', maxWidth: 300, minWidth: 0 }}>
          <div className="eyebrow">Selected</div>
          {sel ? (
            <>
              <div><div style={{ fontSize: 18, fontWeight: 700 }}>{sel.name}</div><div className="mono muted" style={{ fontSize: 11.5 }}>[{sel.kind}{sel.technology ? `: ${sel.technology}` : ''}]</div></div>
              {sel.description && <div style={{ fontSize: 13 }}>{sel.description}</div>}
              {([['Responsibilities', sel.responsibilities], ['Interfaces', sel.interfaces], ['Risks', sel.risks], ['Status', sel.status]] as const).filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="field"><span className="muted">{k}</span><span>{v}</span></div>
              ))}
              {rels.length > 0 && (
                <div className="field">
                  <span className="muted">Connections</span>
                  {rels.map((r) => <span key={r.id} style={{ fontSize: 12.5 }}>{r.source === sel.id ? '→' : '←'} {byId.get(r.source === sel.id ? r.target : r.source)?.name}: {r.label}{r.technology ? ` [${r.technology}]` : ''}</span>)}
                </div>
              )}
              {elements.some((e) => e.parent_id === sel.id) && <button className="btn primary" onClick={() => navigate(`${base}/${sel.id}`)}>Open components ⤵</button>}
            </>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>Select an element to see its details. Elements with components open when clicked.</div>
          )}
        </aside>
      </div>
    </>
  );
}

function Board({ p }: { p: Detail }) {
  const ids = [p.id, ...p.verticals.map((v) => v.id)];
  const [cards, setCards] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    Promise.all(ids.map((id) => api<any[]>(`/board?project=${id}`).then((cs) => cs.map((c) => ({ ...c, board: id }))).catch(() => []))).then((all) => setCards(all.flat()));
  }, [p.id, ids.join(','), tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const name = (id: string) => (id === p.id ? 'Shared' : p.verticals.find((v) => v.id === id)?.name ?? '');
  const lanes = [['backlog', 'Backlog'], ['queued', 'Queued'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['done', 'Done']];
  const shown = cards.filter((c) => filter === 'all' || c.board === filter);
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['all', 'All'], ...ids.map((id) => [id, name(id)])].map(([id, label]) => (
          <button key={id} className={`chip${filter === id ? ' on' : ''}`} onClick={() => setFilter(id)}>{label}</button>
        ))}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{p.phase ? `Phase ${p.phase.index}/${p.phase.count} · ${p.phase.title}` : 'No active phase'}</span>
      </div>
      {cards.length === 0 ? (
        <div className="empty">No cards yet. The PM creates cards for each phase once you approve the roadmap.</div>
      ) : (
        <div className="scroll-x">
          <div className="lanes">
            {lanes.map(([lane, label]) => {
              const items = shown.filter((c) => c.lane === lane);
              return (
                <div key={lane} className="lane">
                  <div className="lane-head"><strong>{label}</strong><span className="mono muted">{items.length}</span></div>
                  {items.map((c) => (
                    <div key={c.id} className={`board-card${c.blocked ? ' blocked' : ''}`}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="mono muted" style={{ fontSize: 10.5 }}>{c.id}</span>
                        <span className="pill t-b" style={{ fontSize: 10.5 }}>{name(c.board)}</span>
                        {c.blocked && <span className="pill t-r" style={{ fontSize: 10.5 }}>blocked</span>}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{c.title}</div>
                      <div className="muted" style={{ fontSize: 11.5, display: 'flex', justifyContent: 'space-between' }}>
                        <span>{c.subs ? `${c.subs.done ?? 0}/${c.subs.total ?? 0} criteria` : ''}</span>
                        <span>{c.agent ?? c.assigned_agent ?? ''}</span>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function Roles({ p, roles, openConversation }: { p: Detail; roles: Role[]; openConversation: (id: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const bring = async (role: Role) => {
    setError(null);
    const name = `${p.slug}-${role.id}`;
    const existing = p.channels.find((c) => c.name === name);
    if (existing) return openConversation(existing.id);
    try {
      const c = await api<{ id: string }>('/api/channels', { body: { name, members: [role.id], project_id: p.id } });
      openConversation(c.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <section className="panel">
        <h2>Bring a role into {p.name}</h2>
        <div className="muted" style={{ fontSize: 13 }}>Opens a project channel with that role. Shared roles keep their knowledge of your other projects.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {roles.filter((r) => r.id !== 'main').map((r) => (
            <button key={r.id} className="btn" onClick={() => bring(r)}>{r.name}</button>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
      </section>
      <section className="panel">
        <h2>Project channels</h2>
        {p.channels.length ? p.channels.map((c) => (
          <button key={c.id} className="nav-row" onClick={() => openConversation(c.id)}><span className="muted">#</span><span className="label">{c.name}</span></button>
        )) : <div className="muted" style={{ fontSize: 13 }}>None yet.</div>}
      </section>
    </>
  );
}

function Agents({ p, openConversation }: { p: Detail; openConversation: (id: string) => void }) {
  const data = useApi<{ runs: { conversation: string; role: string }[]; cards: any[]; recent: any[] }>(`/api/projects/${p.id}/agents`, (m) => ['chat', 'chat_status', 'card'].includes(m?.type));
  if (!data.data) return null;
  const { runs, cards, recent } = data.data;
  return (
    <div className="row">
      <section className="panel grow2">
        <h2>Working now</h2>
        {runs.length === 0 && cards.length === 0 && <div className="empty">No agents are working on {p.name} right now.</div>}
        {runs.map((r) => (
          <button key={r.conversation} className="list-row" style={{ border: 0, background: 'transparent', textAlign: 'left', width: '100%' }} onClick={() => openConversation(r.conversation)}>
            <span className="dot" style={{ background: 'var(--g-fg)', marginTop: 6 }} />
            <span><strong>{r.role}</strong> <span className="muted">in {r.conversation.replace(/^ch:/, '#')}</span></span>
          </button>
        ))}
        {cards.map((c) => (
          <div key={c.id} className="list-row">
            <span className={`pill ${c.lane === 'in_review' ? 't-v' : 't-g'}`}>{c.lane === 'in_review' ? 'review' : 'building'}</span>
            <span><strong>{c.title}</strong> <span className="muted mono" style={{ fontSize: 11 }}>{c.id}{c.assigned_agent ? ` · ${c.assigned_agent}` : ''}</span></span>
          </div>
        ))}
      </section>
      <section className="panel grow1">
        <h2>Recent activity</h2>
        <div className="term">
          {recent.length ? recent.map((r, i) => <div key={i}><span style={{ color: '#6b7585' }}>{new Date(r.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} {r.author}</span> {r.body}</div>) : <div style={{ color: '#6b7585' }}>Nothing yet.</div>}
        </div>
      </section>
    </div>
  );
}

function Docs({ p }: { p: Detail }) {
  const roots = { vault: `vault/projects/${p.slug}`, code: `projects/${p.slug}` };
  const [root, setRoot] = useState<'vault' | 'code'>('vault');
  const [dir, setDir] = useState(roots.vault);
  const [file, setFile] = useState<string | null>(null);
  const listing = useApi<{ kind: string; entries: { name: string; dir: boolean; path: string }[] }>(`/api/files?path=${encodeURIComponent(dir)}`);
  const content = useApi<{ content: string; path: string }>(file ? `/api/files?path=${encodeURIComponent(file)}` : null);
  return (
    <div className="row">
      <section className="panel" style={{ flex: '1 1 260px', maxWidth: 340 }}>
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button aria-pressed={root === 'vault'} onClick={() => (setRoot('vault'), setDir(roots.vault), setFile(null))}>Vault</button>
          <button aria-pressed={root === 'code'} onClick={() => (setRoot('code'), setDir(roots.code), setFile(null))}>Code</button>
        </div>
        <div className="mono muted" style={{ fontSize: 11 }}>{dir}/</div>
        {dir !== roots[root] && <button className="nav-row" onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))}>↑ ..</button>}
        {listing.error && <div className="muted" style={{ fontSize: 13 }}>Nothing here yet.</div>}
        {listing.data?.entries.map((e) => (
          <button key={e.path} className={`nav-row${file === e.path ? ' on' : ''}`} onClick={() => (e.dir ? setDir(e.path) : setFile(e.path))}>
            <span className="muted" style={{ width: 14 }}>{e.dir ? '▸' : '·'}</span>
            <span className="label mono" style={{ fontSize: 12.5 }}>{e.name}{e.dir ? '/' : ''}</span>
          </button>
        ))}
      </section>
      <article className="panel" style={{ flex: '2 1 480px', minWidth: 0, padding: '20px 24px' }}>
        {content.data ? (
          <>
            <div className="mono muted" style={{ fontSize: 12 }}>{content.data.path}</div>
            {content.data.path.endsWith('.md') ? <div className="doc"><Markdown text={content.data.content} /></div> : <pre className="md-pre" style={{ maxHeight: 640 }}>{content.data.content}</pre>}
          </>
        ) : (
          <div className="muted">Choose a file.</div>
        )}
      </article>
    </div>
  );
}

export function ProjectPage({ id, tab, sub, roles, openConversation }: { id: string; tab: string; sub: string | null; roles: Role[]; openConversation: (id: string) => void }) {
  const detail = useApi<Detail>(`/api/projects/${id}`, refresh(id));
  const p = detail.data;
  if (detail.error) return <div className="error">{detail.error}</div>;
  if (!p) return null;
  const base = `/project/${id}`;
  return (
    <>
      <div className="proj-head">
        <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="muted" style={{ fontSize: 12 }}>Projects / {p.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{p.name}</h1>
            <span className="pill t-g">{STAGE_NAMES[p.stage]}{p.phase ? ` · phase ${p.phase.index} of ${p.phase.count}` : ''}</span>
            <span className="mono muted" style={{ fontSize: 12 }}>{p.root.split('/').slice(-2).join('/')}</span>
          </div>
          {p.description && <div className="muted" style={{ fontSize: 13 }}>{p.description}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <StageSteps stage={p.stage} />
          <Gate p={p} openConversation={openConversation} />
        </div>
      </div>
      <div role="tablist" className="tabs">
        {TABS.map(([t, label]) => (
          <a key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' on' : ''}`} href={href(t ? `${base}/${t}` : base)} onClick={go(t ? `${base}/${t}` : base)}>
            {label}
          </a>
        ))}
      </div>
      {tab === '' && <Overview p={p} openConversation={openConversation} />}
      {tab === 'requirements' && <Requirements p={p} />}
      {tab === 'design' && <SystemDesign p={p} focus={sub} openConversation={openConversation} />}
      {tab === 'board' && <Board p={p} />}
      {tab === 'roles' && <Roles p={p} roles={roles} openConversation={openConversation} />}
      {tab === 'agents' && <Agents p={p} openConversation={openConversation} />}
      {tab === 'docs' && <Docs p={p} />}
    </>
  );
}
