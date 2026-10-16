import { when } from '../lib/time';
import { useEffect, useMemo, useState, useRef } from 'react';
import { PROJECT_TABS } from '../components/CommandBar';
import { LiveCard } from '../components/LiveCard';
import { Diagram, Legend, type Element, type Relation } from '../components/Diagram';
import { Modal } from '../components/Dialogs';
import { TeamPopup, type Recommendation } from '../components/TeamPopup';
import { Icon } from '../components/Icon';
import { StageSteps } from '../components/Shell';
import { api, useApi } from '../lib/api';
import { Markdown } from '../lib/md';
import { go, href, navigate } from '../lib/router';
import type { Role } from '../lib/types';

const TABS = PROJECT_TABS;

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
  containers: { id: string; name: string; components: number }[];
  phase: { index: number; count: number; title: string } | null;
  phases: { id: string; title: string; goal: string | null; status: string }[];
  cards: { done: number; total: number };
  liveAgents: number;
  blocked: number;
  inReview: number;
  channels: { id: string; name: string }[];
  decisions: { id: number; title: string; why: string | null; role_id: string | null; created_at: number }[];
  status: 'active' | 'paused' | 'review' | 'closed';
  closed_reason: string | null;
  rag: string | null;
  requirementsFinal: boolean;
  requirementsVersion: number | null;
  requirementsOpen: string[];
  stages: string[];
  type?: 'software' | 'general';
  plugins?: string[];
  typeName: string;
  pluginList: { id: string; name: string; icon: string; description: string; suggested: boolean; on: boolean; overviewCard: boolean }[];
  team: { role_id: string; kind: string; reason: string | null; name: string; initials: string; tone: string; skill: string | null; scope: string }[];
  recommendation: Recommendation | null;
  last_activity: number;
}

const refresh = (id: string) => (m: any) =>
  (['brain_project', 'requirements', 'design', 'decisions', 'conversations', 'team', 'memory'].includes(m?.type) && (!m.project_id || m.project_id === id)) || ['card', 'phases', 'card_removed'].includes(m?.type);

const ROLE_LABEL: Record<string, string> = { architect: 'Architect', pm: 'PM', cto: 'CTO' };

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

interface GateAction {
  label: string;
  confirm: string;
  hint: string;
  path?: string;
  body?: unknown;
  steps: string[];
  disabled?: boolean;
  open?: 'team';
  danger?: boolean;
  warning?: string;
}

function Gate({ p, openConversation, openTeam }: { p: Detail; openConversation: (id: string) => void; openTeam: () => void }) {
  const design = p.plugins?.includes('design') ?? true;
  const [confirming, setConfirming] = useState<GateAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<string | null>(null);
  const [reason, setReason] = useState<'completed' | 'cancelled'>('completed');
  const close = () => {
    setConfirming(null);
    setError(null);
    setNeeds(null);
  };
  const run = async (a: GateAction) => {
    setBusy(true);
    setError(null);
    try {
      if (needs) await api('/api/roles', { body: { template: needs } });
      const body = a.path?.endsWith('/status') && (a.body as any)?.status === 'closed' ? { ...(a.body as any), reason } : a.body;
      const res = await fetch(a.path!, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      const r = await res.json();
      if (res.status === 409 && r.needs_role) {
        setNeeds(r.needs_role);
        setError(r.error);
        return;
      }
      if (!res.ok) throw new Error(r.error ?? res.statusText);
      close();
      if (r?.channel) openConversation(r.channel);
      if (r?.recommendation) openTeam();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const containers = p.containers ?? [];
  const base = `/api/projects/${p.id}`;
  const actions: GateAction[] = [];
  if (p.status === 'closed') {
    actions.push({ label: 'Reopen project', confirm: 'Reopen project', hint: `Closed${p.closed_reason ? ` (${p.closed_reason})` : ''}.`, path: `${base}/status`, body: { status: 'active' }, steps: ['The project becomes active again; check-ins resume while it is building.', 'Nothing else changes: its threads, board and memory are as you left them.'] });
  } else if (p.status === 'paused') {
    actions.push({ label: 'Resume project', confirm: 'Resume project', hint: 'Paused: no check-ins.', path: `${base}/status`, body: { status: 'active' }, steps: ['Check-ins resume: the Main agent asks for status after 2 hours without activity.', 'Agents do not restart on their own; continue in the build thread.'] });
  } else if (p.status === 'review') {
    actions.push({
      label: 'Sign off and close',
      confirm: 'Sign off and close',
      hint: 'Close-out: readiness check, retrospective and enhancements.',
      path: `${base}/status`,
      body: { status: 'closed' },
      steps: ['The project is marked Closed with the reason you choose, and check-ins stop.', 'Lessons stay in project memory; proposed enhancements stay listed on the Memory tab.', 'You can reopen it later.'],
    });
  } else if (p.stage === 'requirements' && !p.requirementsFinal) {
    actions.push({
      label: 'Mark requirements final',
      confirm: 'Mark requirements final',
      hint: design ? 'Next: pick the team, then the design starts.' : 'Next: pick the team, then the PM plans the work.',
      path: `${base}/requirements/final`,
      warning: p.requirementsOpen.length ? `Still marked “To discuss”: ${p.requirementsOpen.join(', ')}. The team will have to guess these; consider filling them in with the Main agent first.` : undefined,
      steps: [
        `Requirements${p.requirementsVersion ? ` v${p.requirementsVersion}` : ''} are locked. You can reopen them later from the Requirements tab.`,
        design ? 'You get a recommended team: always an Architect, a PM, Quality control and a Security Champion, plus specialists the Main agent picks from the requirements.' : 'You get a recommended team: always a PM and Quality control, plus specialists the Main agent picks from the brief.',
        design ? 'Nothing is designed or built until you start the design.' : 'No work starts until you start the planning.',
      ],
    });
  } else if (p.stage === 'requirements') {
    actions.push({ label: design ? 'Pick the team and start design' : 'Pick the team and start planning', confirm: '', hint: 'Requirements are final.', open: 'team', steps: [] });
  } else if (p.stage === 'design') {
    actions.push({
      label: 'Finalise design',
      confirm: 'Finalise design',
      hint: 'Creates the verticals and asks the PM for a roadmap.',
      path: `${base}/design/final`,
      steps: [
        'The current design is saved as a final version.',
        containers.length ? `A board vertical and folder are created for each app: ${containers.map((c) => c.name).join(', ')}.` : 'A board vertical and folder are created for each app container in the design.',
        `The PM drafts a roadmap of phases in #${p.slug} › build and waits for your approval before building.`,
      ],
    });
  } else if (p.stage === 'plan') {
    actions.push({
      label: 'Approve roadmap and start building',
      confirm: 'Approve and start building',
      hint: p.phases.length ? `${p.phases.length} phases proposed.` : 'Waiting for the PM to propose phases.',
      path: `${base}/start`,
      disabled: !p.phases.length,
      steps: [`The PM starts the first of ${p.phases.length} phases: ${p.phases.map((x) => x.title).join(' → ')}.`, 'Builder and reviewer agents create and work cards on the board, in separate git worktrees. Security cards get a security scan and review.', 'Anything they are not allowed to do on their own still asks you first. This is the stage that uses the most of your subscription.'],
    });
  }
  const pausable = p.status === 'active' && p.stage !== 'requirements';
  return (
    <div className="gate" style={{ flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{p.status === 'review' ? 'Close-out' : p.status === 'closed' ? 'Closed' : p.status === 'paused' ? 'Paused' : 'Next gate'}</span>
        <span className="muted" style={{ fontSize: 12 }}>{actions[0]?.hint ?? `Building · last activity ${ago(p.last_activity)}`}</span>
      </div>
      {actions.map((a) => (
        <button key={a.label} className="btn primary" disabled={a.disabled} onClick={() => (a.open === 'team' ? openTeam() : setConfirming(a))}>
          {a.label}
        </button>
      ))}
      {pausable && (
        <button className="btn sm" onClick={() => setConfirming({ label: 'Pause project', confirm: 'Pause project', hint: '', path: `${base}/status`, body: { status: 'paused' }, steps: ['Check-ins stop for this project.', 'Agents already working finish their current reply; nobody starts new work until you resume.', 'You can resume any time.'] })}>
          Pause
        </button>
      )}
      {confirming && (
        <Modal title={`${confirming.label}?`} onClose={close} width={520}>
          <div style={{ fontSize: 13 }}><strong>{p.name}</strong>: this will</div>
          <ul className="md-list" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
            {confirming.steps.map((s) => <li key={s}>{s}</li>)}
          </ul>
          {confirming.label === 'Sign off and close' && (
            <label className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>Reason
              <select className="input" style={{ height: 32, color: 'var(--text)' }} value={reason} onChange={(e) => setReason(e.target.value as any)}><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>
            </label>
          )}
          {confirming.warning && <div className="banner t-a" style={{ fontSize: 12.5 }}>{confirming.warning}</div>}
          {needs && <div className="banner t-a" style={{ fontSize: 12.5 }}>{error} Confirming adds {ROLE_LABEL[needs] ?? needs} to your team first.</div>}
          {error && !needs && <div className="error">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={busy} onClick={() => run(confirming)}>
              {busy ? 'Working…' : needs ? `Add ${ROLE_LABEL[needs] ?? needs} and continue` : `Yes, ${confirming.confirm.toLowerCase()}`}
            </button>
            <button className="btn" disabled={busy} onClick={close}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const shortThread = (name: string, slug: string) => (name.startsWith(`${slug}-`) ? name.slice(slug.length + 1) : name);

/** A plugin page for a project that has it switched off. */
function PluginOff({ p, id }: { p: Detail; id: string }) {
  const m = p.pluginList.find((x) => x.id === id);
  return (
    <div className="empty" style={{ padding: 36 }}>
      {m ? <><strong>{m.name}</strong> is off for {p.name}. {m.description}</> : 'No such page.'}
      {m && <div style={{ marginTop: 12 }}><button className="btn sm" onClick={() => api(`/api/projects/${p.id}/plugins`, { body: { id, on: true } })}>Turn on {m.name}</button></div>}
    </div>
  );
}

/** Plugins on this project: what each adds, with a switch. Off only hides a plugin and its agent tools; its data stays. */
function Plugins({ p }: { p: Detail }) {
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (id: string, on: boolean) => {
    setBusy(id);
    try {
      await api(`/api/projects/${p.id}/plugins`, { body: { id, on } });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2>Plugins</h2><span className="muted" style={{ fontSize: 12 }}>{p.typeName} project</span></div>
      {p.pluginList.map((x) => (
        <div key={x.id} className="check-row" style={{ alignItems: 'flex-start' }}>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{x.name} {x.suggested && <span className="pill t-n" style={{ marginLeft: 4 }}>suggested</span>}</span>
            <span className="muted" style={{ fontSize: 12 }}>{x.description}</span>
          </span>
          <button role="switch" aria-checked={x.on} aria-label={`${x.name} for this project`} className="switch" disabled={busy !== null} onClick={() => toggle(x.id, !x.on)}><span /></button>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 11.5 }}>Switched-on plugins appear under the project in the sidebar. Turning one off hides it and its agent tools; nothing is deleted.</div>
    </section>
  );
}

function Overview({ p, openConversation, newThread }: { p: Detail; openConversation: (id: string) => void; newThread: () => void }) {
  const kpis = [
    { label: 'Stage', value: STAGE_NAMES[p.stage], sub: p.description ?? '' },
    { label: 'Current phase', value: p.phase ? `${p.phase.index} of ${p.phase.count}` : '—', sub: p.phase?.title ?? 'Not planned yet' },
    { label: 'Cards this phase', value: p.cards.total ? `${p.cards.done} / ${p.cards.total}` : '—', sub: `${p.inReview} in review · ${p.blocked} blocked` },
    { label: 'Live agents', value: String(p.liveAgents), sub: p.channels.length ? `${p.channels.length} discussion${p.channels.length === 1 ? '' : 's'}` : 'No discussions yet' },
  ];
  return (
    <>
      {p.plugins?.includes('live') && <LiveCard projectId={p.id} />}
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
          {p.plugins?.includes('design') && (
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
          )}
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
            <div className="panel-head"><h2>Discussions</h2><button className="btn sm" onClick={newThread}>+ New thread</button></div>
            {p.channels.length ? p.channels.map((c) => (
              <button key={c.id} className="nav-row" onClick={() => openConversation(c.id)}><span className="muted">#</span><span className="label">{shortThread(c.name, p.slug)}</span></button>
            )) : <div className="muted" style={{ fontSize: 13 }}>Threads about this project appear here: the stage threads the agents start, and any you open with your team.</div>}
          </section>
          <Plugins p={p} />
        </div>
      </div>
    </>
  );
}

function ReopenButton({ p }: { p: Detail }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>Reopen</button>
      {open && (
        <Modal title="Reopen requirements?" onClose={() => setOpen(false)} width={480}>
          <ul className="md-list" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
            <li>{p.name} goes back to the Requirements stage and the document becomes editable again.</li>
            <li>The existing design and roadmap stay as they are; review them after you change the requirements.</li>
          </ul>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await api(`/api/projects/${p.id}/requirements/reopen`, { method: 'POST' }); setOpen(false); }}>
              Yes, reopen requirements
            </button>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </Modal>
      )}
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
          <ReopenButton p={p} />
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
  const elParam = new URLSearchParams(location.search).get('el');
  const [selected, setSelected] = useState<string | null>(elParam);
  useEffect(() => setSelected(elParam), [focus, elParam]);
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
      <section className="panel design-panel" style={{ padding: 0, gap: 0 }}>
        <div style={{ padding: '14px 18px 0' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{level} — {focus ? byId.get(focus)?.name : p.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>C4 · generated from the design model · click an element for details, double-click to open its components</div>
        </div>
        <Diagram elements={elements} relations={relations} focus={focus} selected={selected} onSelect={setSelected} onDrill={(id) => navigate(`${base}/${id}`)} focusName={focus ? byId.get(focus)?.name ?? '' : p.name} />
        <Legend />
        {sel && (
          <aside className="design-inspector" aria-label={`${sel.name} details`}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 17, fontWeight: 700 }}>{sel.name}</div><div className="mono muted" style={{ fontSize: 11.5 }}>[{sel.kind}{sel.technology ? `: ${sel.technology}` : ''}]</div></div>
              <button className="icon-btn" style={{ width: 28, height: 28, flex: '0 0 28px', borderRadius: 8, fontSize: 13 }} aria-label="Close details" title="Close details" onClick={() => setSelected(null)}>✕</button>
            </div>
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
          </aside>
        )}
      </section>
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
  const cardParam = new URLSearchParams(location.search).get('card');
  const scrolledTo = useRef<string | null>(null);
  const reveal = (el: HTMLDivElement | null) => {
    if (el && scrolledTo.current !== cardParam) (scrolledTo.current = cardParam, el.scrollIntoView({ block: 'nearest', inline: 'center' }));
  };
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
                    <div key={c.id} className={`board-card${c.blocked ? ' blocked' : ''}${c.id === cardParam ? ' hit' : ''}`} ref={c.id === cardParam ? reveal : undefined}>
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

function ProjectTeam({ p, openTeam }: { p: Detail; openTeam: () => void }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const templates = useApi<{ id: string; blurb: string }[]>('/api/role-templates', (m) => m?.type === 'roles');
  const blurb = new Map((templates.data ?? []).map((t) => [t.id, t.blurb]));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Project team</h2>
        {p.recommendation && <button className="btn sm" onClick={openTeam}>Recommended team</button>}
      </div>
      {p.team.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>{p.requirementsFinal ? 'No members yet: open the recommended team.' : 'The team is recommended when the requirements are final.'}</div>
      ) : (
        p.team.map((m) => (
          <div key={m.role_id} className="check-row">
            <span className={`avatar t-${m.tone}`}>{m.initials}</span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{m.name} <span className={`pill ${m.kind === 'core' ? 't-b' : 't-v'}`} style={{ marginLeft: 6 }}>{m.kind}</span></span>
              {blurb.get(m.role_id) && <span style={{ fontSize: 12, color: 'var(--text2)' }}>{blurb.get(m.role_id)}</span>}
              {m.reason && <span className="muted" style={{ fontSize: 12 }}>Why on this project: {m.reason}</span>}
            </span>
            {m.skill && <span className="pill t-n mono" style={{ fontSize: 10.5 }}>{m.skill}</span>}
            <button className="link-btn" style={{ color: 'var(--r-fg)', fontSize: 12 }} onClick={() => setRemoving(m.role_id)}>Remove</button>
          </div>
        ))
      )}
      {removing && (
        <Modal title="Remove from this project?" onClose={() => setRemoving(null)} width={460}>
          <div style={{ fontSize: 13 }}>{p.team.find((m) => m.role_id === removing)?.name} leaves {p.name}'s team. They stay on your team and keep their learnings; their threads here are kept.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" onClick={async () => { await api(`/api/projects/${p.id}/team/${removing}`, { method: 'DELETE' }); setRemoving(null); }}>Yes, remove</button>
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Memory({ p }: { p: Detail }) {
  const m = useApi<{ lessons: any[]; digest: string; checklist: string[]; enhancements: any[]; learnings: { role_id: string; name: string; items: { id: number; rule: string; count: number }[] }[]; threatModel: string | null }>(
    `/api/projects/${p.id}/memory`,
    (x) => ['memory', 'brain_project', 'design'].includes(x?.type),
  );
  const [showThreat, setShowThreat] = useState(false);
  if (!m.data) return null;
  const d = m.data;
  const active = d.lessons.filter((l) => l.status === 'active');
  return (
    <>
      <div className="banner t-b" style={{ fontSize: 12.5 }}>
        Blameless: every failed review is classified by cause. Process problems become project lessons with a check added; a member gets a personal learning only when they repeat a mistake. Every agent on {p.name} reads this memory.
      </div>
      <div className="row">
        <section className="panel grow2">
          <div className="panel-head"><h2>Lessons register</h2><span className="muted" style={{ fontSize: 12 }}>{active.length} active · {d.lessons.length - active.length} superseded</span></div>
          {d.lessons.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No lessons yet. They are recorded when a review fails and in the close-out retrospective.</div>
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th>ID</th><th>Cause</th><th>Lesson</th><th>Check added</th><th>Seen</th></tr></thead>
                <tbody>
                  {d.lessons.map((l) => (
                    <tr key={l.id} style={{ opacity: l.status === 'active' ? 1 : 0.55 }}>
                      <td className="mono">L{l.id}</td>
                      <td><span className={`pill ${l.cause === 'agent-behavior' ? 't-a' : 't-n'}`}>{l.cause}</span></td>
                      <td>{l.lesson}{l.status !== 'active' && <span className="muted"> (superseded)</span>}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{l.mechanism ?? '—'}</td>
                      <td className="mono">×{l.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <aside className="panel grow1">
          <h2>Member learnings</h2>
          {d.learnings.every((x) => x.items.length === 0) && <div className="muted" style={{ fontSize: 13 }}>None: learnings appear when a member repeats the same mistake.</div>}
          {d.learnings.filter((x) => x.items.length).map((x) => (
            <div key={x.role_id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong style={{ fontSize: 13 }}>{x.name}</strong>
              {x.items.map((l) => <div key={l.id} style={{ fontSize: 12.5 }}>· {l.rule} <span className="muted">×{l.count}</span></div>)}
            </div>
          ))}
          {d.checklist.length > 0 && (
            <>
              <div className="eyebrow" style={{ fontWeight: 700, marginTop: 6 }}>Team checklist</div>
              {d.checklist.map((c) => <div key={c} style={{ fontSize: 12.5 }}>· {c}</div>)}
            </>
          )}
        </aside>
      </div>
      <div className="row">
        <section className="panel grow2">
          <div className="panel-head"><h2>Threat model</h2>{d.threatModel && <button className="btn sm" onClick={() => setShowThreat(!showThreat)}>{showThreat ? 'Hide' : 'Show'}</button>}</div>
          {d.threatModel ? (showThreat ? <div className="doc"><Markdown text={d.threatModel} /></div> : <div className="muted" style={{ fontSize: 13 }}>STRIDE threat model by the Security Champion, saved in the vault.</div>) : <div className="muted" style={{ fontSize: 13 }}>Written by the Security Champion when the design is ready.</div>}
        </section>
        <aside className="panel grow1">
          <h2>Enhancements</h2>
          {d.enhancements.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Proposed during the close-out.</div>}
          {d.enhancements.map((e) => (
            <div key={e.id} className="check-row">
              <span style={{ flex: 1, fontSize: 13, opacity: e.status === 'dropped' ? 0.5 : 1 }}><strong>{e.title}</strong>{e.why && <span className="muted"> · {e.why}</span>}</span>
              {e.status === 'proposed' ? (
                <>
                  <button className="btn sm" onClick={() => api(`/api/enhancements/${e.id}`, { body: { status: 'accepted' } }).then(m.reload)}>Accept</button>
                  <button className="btn sm" style={{ borderColor: 'transparent' }} onClick={() => api(`/api/enhancements/${e.id}`, { body: { status: 'dropped' } }).then(m.reload)}>Drop</button>
                </>
              ) : (
                <span className={`pill ${e.status === 'accepted' ? 't-g' : 't-n'}`}>{e.status}</span>
              )}
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}

function Roles({ p, roles, openConversation, openTeam }: { p: Detail; roles: Role[]; openConversation: (id: string) => void; openTeam: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const bring = async (role: Role) => {
    setError(null);
    const existing = p.channels.find((c) => c.id === `ch:${p.slug}-${role.id}` || c.name === role.name);
    if (existing) return openConversation(existing.id);
    try {
      const c = await api<{ id: string }>('/api/channels', { body: { name: role.name, members: [role.id], project_id: p.id } });
      openConversation(c.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const onTeam = new Set(p.team.map((m) => m.role_id));
  const members = roles.filter((r) => onTeam.has(r.id));
  const others = roles.filter((r) => r.id !== 'main' && !onTeam.has(r.id));
  return (
    <>
      <ProjectTeam p={p} openTeam={openTeam} />
      <section className="panel">
        <h2>Talk to a member about {p.name}</h2>
        <div className="muted" style={{ fontSize: 13 }}>Opens a thread in this project's Discussions with that member.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {members.map((r) => (
            <button key={r.id} className="btn" onClick={() => bring(r)}>{r.name}</button>
          ))}
          {!members.length && <span className="muted" style={{ fontSize: 13 }}>Nobody is on this project's team yet.</span>}
        </div>
        {others.length > 0 && (
          <details>
            <summary className="muted" style={{ fontSize: 12.5, cursor: 'pointer' }}>Not on this project ({others.length}): ask them anyway</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {others.map((r) => <button key={r.id} className="btn sm" onClick={() => bring(r)}>{r.name}</button>)}
            </div>
          </details>
        )}
        {error && <div className="error">{error}</div>}
      </section>
      <section className="panel">
        <h2>Project discussions</h2>
        {p.channels.length ? p.channels.map((c) => (
          <button key={c.id} className="nav-row" onClick={() => openConversation(c.id)}><span className="muted">#</span><span className="label">{shortThread(c.name, p.slug)}</span></button>
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
          {recent.length ? recent.map((r, i) => <div key={i}><span style={{ color: '#6b7585' }}>{when(r.created_at)} {r.author}</span> {r.body}</div>) : <div style={{ color: '#6b7585' }}>Nothing yet.</div>}
        </div>
      </section>
    </div>
  );
}

function Docs({ p }: { p: Detail }) {
  const roots = { vault: `vault/projects/${p.slug}`, code: `projects/${p.slug}` };
  const [root, setRoot] = useState<'vault' | 'code'>('vault');
  const fileParam = new URLSearchParams(location.search).get('file');
  const [dir, setDir] = useState(roots.vault);
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    if (!fileParam) return;
    setRoot(fileParam.startsWith('vault/') ? 'vault' : 'code');
    setDir(fileParam.split('/').slice(0, -1).join('/'));
    setFile(fileParam);
  }, [fileParam]);
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

export function ProjectPage({ id, tab, sub, roles, openConversation, newThread, side }: { id: string; tab: string; sub: string | null; roles: Role[]; openConversation: (id: string) => void; newThread: () => void; side: { open: boolean; toggle: () => void } }) {
  const detail = useApi<Detail>(`/api/projects/${id}`, refresh(id));
  const p = detail.data;
  const [teamOpen, setTeamOpen] = useState(false);
  const [autoShown, setAutoShown] = useState(false);
  const tabsRef = useRef<HTMLElement>(null);
  const [tabsMore, setTabsMore] = useState('');
  const measureTabs = () => {
    const el = tabsRef.current;
    if (!el) return;
    setTabsMore((el.scrollLeft > 4 ? ' more-left' : '') + (el.scrollLeft + el.clientWidth < el.scrollWidth - 4 ? ' more-right' : ''));
  };
  useEffect(() => {
    measureTabs();
    window.addEventListener('resize', measureTabs);
    return () => window.removeEventListener('resize', measureTabs);
  });
  // the team step: open the recommendation once, as soon as requirements are final
  useEffect(() => {
    if (!autoShown && p && p.stage === 'requirements' && p.requirementsFinal && p.recommendation?.status === 'open') {
      setTeamOpen(true);
      setAutoShown(true);
    }
  }, [p, autoShown]);
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
            {p.status !== 'active' && <span className={`pill ${p.status === 'review' ? 't-v' : p.status === 'paused' ? 't-a' : 't-n'}`}>{p.status === 'review' ? 'Close-out' : p.status === 'paused' ? 'Paused' : `Closed${p.closed_reason ? ` · ${p.closed_reason}` : ''}`}</span>}
            {p.rag && p.status === 'active' && <span className={`pill ${p.rag === 'green' ? 't-g' : p.rag === 'amber' ? 't-a' : 't-r'}`} title="Status reported by the PM">{p.rag}</span>}
            <span className="mono muted" style={{ fontSize: 12 }}>{p.root.split('/').slice(-2).join('/')}</span>
          </div>
          {p.description && <div className="muted" style={{ fontSize: 13 }}>{p.description}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <StageSteps stage={p.stage} type={p.type} />
            <button className={`btn sm${side.open ? ' on' : ''}`} aria-pressed={side.open} onClick={side.toggle} title={side.open ? 'Hide the chat panel' : tab ? 'Show the chat panel over this page' : 'Show the chat panel'}>
              <Icon name="chat" size={14} /> {side.open ? 'Hide chat' : 'Chat'}
            </button>
          </div>
          <Gate p={p} openConversation={openConversation} openTeam={() => setTeamOpen(true)} />
        </div>
      </div>
      <nav aria-label="Project sections" className={`tabs${tabsMore}`} ref={tabsRef} onScroll={measureTabs}>
        {TABS.map(([t, label]) => (
          <a key={t} aria-current={tab === t ? 'page' : undefined} className={`tab${tab === t ? ' on' : ''}`} href={href(t ? `${base}/${t}` : base)} onClick={go(t ? `${base}/${t}` : base)}>
            {label}
          </a>
        ))}
      </nav>
      {tab === '' && <Overview p={p} openConversation={openConversation} newThread={newThread} />}
      {tab === 'requirements' && <Requirements p={p} />}
      {tab === 'design' && (p.plugins?.includes('design') ? <SystemDesign p={p} focus={sub} openConversation={openConversation} /> : <PluginOff p={p} id="design" />)}
      {tab === 'live' && (p.plugins?.includes('live') ? <LiveCard projectId={p.id} /> : <PluginOff p={p} id="live" />)}
      {tab === 'board' && <Board p={p} />}
      {tab === 'roles' && <Roles p={p} roles={roles} openConversation={openConversation} openTeam={() => setTeamOpen(true)} />}
      {tab === 'memory' && <Memory p={p} />}
      {teamOpen && p.recommendation && (
        <TeamPopup projectId={p.id} projectName={p.name} slug={p.slug} rec={p.recommendation} design={p.plugins?.includes('design') ?? true} onClose={() => setTeamOpen(false)} onStarted={openConversation} />
      )}
      {tab === 'agents' && <Agents p={p} openConversation={openConversation} />}
      {tab === 'docs' && <Docs p={p} />}
    </>
  );
}
