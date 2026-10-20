// The project workspace: its own menu (sections grouped Plan / Build /
// Knowledge, with live counts), a top bar with what waits on you, and the
// Overview: the project and its status on the left, what is live on the right
// (Run, and what is being worked on right now).
import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../lib/api';
import { go, href, navigate } from '../lib/router';
import { when } from '../lib/time';
import { Icon, type IconName } from './Icon';

export interface OverviewData {
  needs: { card: string; project_id: string; title: string; reason: string; command: string | null; vertical: string; since: number }[];
  working: { card: string; title: string; step: string; agent: string; vertical: string; since: number }[];
  chats: { conversation: string; agent: string; where: string }[];
  verticals: { id: string; name: string; done: number; total: number; blocked: number; technology: string | null; description: string | null; who: string[] }[];
  usage: { week: { day: string; cost: number }[]; total: number; builderRuns: number; builderMs: number; planPct: number | null };
}

/** Everything that changes what the Overview shows. */
export const overviewEvents = (id: string) => (m: any) => ['card', 'card_removed', 'chat_status', 'live', 'phases', 'brain_project'].includes(m?.type) && (!m.project_id || m.project_id === id || m.type === 'chat_status' || m.type === 'card');

export function useOverview(id: string) {
  return useApi<OverviewData>(`/api/projects/${id}/overview`, overviewEvents(id));
}

/** Clear a blocker the user resolved; the project's lead carries on with the card. */
async function unblock(projectId: string, card: string) {
  await api(`/api/projects/${projectId}/cards/${card}/unblock`, { method: 'POST' });
}

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  meta?: string;
  alert?: number;
}

/** The project's own menu, beside the page. */
export function ProjectNav({ name, sub, color, groups, tab, base, foot }: { name: string; sub: string; color: string; groups: { title: string; items: NavItem[] }[]; tab: string; base: string; foot: React.ReactNode }) {
  return (
    <nav className="ws-nav" aria-label={name}>
      <a className="ws-nav-project" href={href('/')} onClick={go('/')} title="All projects">
        <span className="ws-swatch" style={{ background: color }} aria-hidden="true" />
        <span className="ws-nav-name">{name}</span>
      </a>
      <span className="ws-nav-sub">{sub}</span>
      <div className="ws-nav-scroll">
        {groups.map((g) => (
          <div key={g.title || 'top'} className="ws-nav-group">
            {g.title && <span className="ws-nav-h">{g.title}</span>}
            {g.items.map((i) => {
              const to = i.id ? `${base}/${i.id}` : base;
              const on = tab === i.id || (i.id === 'ui' && tab === 'brand');
              return (
                <a key={i.id} className={`ws-nav-item${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} href={href(to)} onClick={go(to)}>
                  <Icon name={i.icon} className="ws-nav-icon" />
                  <span className="ws-nav-label">{i.label}</span>
                  {Boolean(i.alert) && <span className="ws-alert" aria-label={`${i.alert} waiting on you`}>{i.alert}</span>}
                  {i.meta && <span className="ws-meta">{i.meta}</span>}
                </a>
              );
            })}
          </div>
        ))}
      </div>
      <div className="ws-nav-foot">{foot}</div>
    </nav>
  );
}

/** The top bar: where you are, what waits on you (from any section), and the chat. */
export function ProjectBar({ projectId, trail, needs, chat }: { projectId: string; trail: string[]; needs: OverviewData['needs']; chat: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', close), document.removeEventListener('keydown', esc));
  }, [open]);
  return (
    <header className="ws-bar">
      <span className="ws-trail">
        {trail.map((t, i) => (
          <span key={i} className={i === trail.length - 1 ? 'here' : undefined}>{i > 0 && <span aria-hidden="true"> / </span>}{t}</span>
        ))}
      </span>
      <div className="ws-bar-actions" ref={ref}>
        {needs.length > 0 && (
          <button className="ws-for-you" aria-expanded={open} onClick={() => setOpen(!open)}>{needs.length} for you</button>
        )}
        {chat}
        {open && (
          <div className="ws-queue" role="dialog" aria-label="Waiting on you">
            {needs.map((n) => <NeedRow key={n.card} projectId={projectId} n={n} compact />)}
          </div>
        )}
      </div>
    </header>
  );
}

function NeedRow({ projectId, n, compact }: { projectId: string; n: OverviewData['needs'][number]; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const done = async () => {
    setBusy(true);
    setError(null);
    try {
      await unblock(projectId, n.card);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className={`ws-need${compact ? ' compact' : ''}`}>
      <span className="ws-need-text">
        <strong>{n.title}</strong>
        <span>{n.reason}</span>
      </span>
      {n.command && (
        <button className="ws-cmd" title="Copy" onClick={() => void navigator.clipboard?.writeText(n.command!).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1400)))}>
          <code>{n.command}</code>
          <span className="ws-cmd-copy">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      )}
      <button className="btn sm primary" disabled={busy} onClick={done} title="Clears the blocker; the PM carries on with the card">{busy ? 'Telling the PM…' : 'Done, carry on'}</button>
      {error && <span className="error" style={{ fontSize: 12 }}>{error}</span>}
    </div>
  );
}

/** The project and its status: the left column's top. */
export function NeedsYou({ projectId, needs }: { projectId: string; needs: OverviewData['needs'] }) {
  if (!needs.length) return null;
  return (
    <section className="ws-needs" aria-labelledby="ws-needs-h">
      <h2 id="ws-needs-h">Needs you · {needs.length}</h2>
      {needs.map((n) => <NeedRow key={n.card} projectId={projectId} n={n} />)}
    </section>
  );
}

interface Live {
  status: 'stopped' | 'installing' | 'starting' | 'live' | 'paused' | 'crashed' | 'error' | 'needs_approval' | 'launched';
  message: string | null;
  runnable: boolean;
  services: { name: string; primary: boolean; status: string; url: string }[];
}
const LIVE_TEXT: Record<Live['status'], string> = {
  live: 'Running', starting: 'Starting…', installing: 'Installing…', paused: 'Paused', stopped: 'Stopped', crashed: 'Crashed', error: 'Needs attention', needs_approval: 'Waiting for you', launched: 'Opened',
};

/** Run the project on an environment (This Mac now; staging and production later). */
export function RunPanel({ projectId, enabled, base }: { projectId: string; enabled: boolean; base: string }) {
  const live = useApi<Live>(enabled ? `/api/projects/${projectId}/live` : null, (m) => m?.type === 'live' && m.project_id === projectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const l = live.data;
  const act = async (what: 'start' | 'stop' | 'resume') => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<any>(`/api/projects/${projectId}/live/${what}`, { method: 'POST' });
      // keys or a database to approve first: the full panel handles that
      if (what === 'start' && r.status === 'needs_approval') navigate(`${base}/live`);
      live.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const up = l && ['live', 'starting', 'installing', 'crashed'].includes(l.status);
  const primary = l?.services.find((s) => s.primary);
  return (
    <section className="ws-card ws-run" aria-labelledby="ws-run-h">
      <h2 id="ws-run-h" className="ws-h">Run</h2>
      {!enabled ? (
        <span className="ws-dim">Running on this Mac is off for this project. Turn on the On this Mac plugin in its settings.</span>
      ) : (
        <>
          <div className="ws-run-row">
            {l?.status === 'paused' ? (
              <button className="btn primary ws-run-btn" disabled={busy} onClick={() => act('resume')}><Icon name="play" size={13} /> Resume</button>
            ) : up ? (
              <button className="btn ws-run-btn" disabled={busy} onClick={() => act('stop')}><Icon name="stop" size={13} /> Stop</button>
            ) : (
              <button className="btn primary ws-run-btn" disabled={busy || (l ? !l.runnable : true)} title={l && !l.runnable ? l.message ?? 'Not runnable yet' : undefined} onClick={() => act('start')}><Icon name="play" size={13} /> Run</button>
            )}
          </div>
          <label className="ws-field">
            <span>Environment</span>
            <select className="input">
              <option>This Mac</option>
              <option disabled>Staging · coming later</option>
              <option disabled>Production · coming later</option>
            </select>
          </label>
          <span className="ws-dim">
            {!l ? 'Checking…' : l.runnable || up ? <>{LIVE_TEXT[l.status]}{primary?.url && up ? <> at <a href={primary.url} target="_blank" rel="noreferrer">{primary.url.replace(/^https?:\/\//, '')}</a></> : null}</> : l.message ?? 'Not runnable yet: the developer adds its run recipe while building.'}
          </span>
          <a className="ws-link" href={href(`${base}/live`)} onClick={go(`${base}/live`)}>Logs and databases</a>
        </>
      )}
      {error && <span className="error" style={{ fontSize: 12 }}>{error}</span>}
    </section>
  );
}

/** Cards in hand and agents talking right now. */
export function WorkingNow({ data, openConversation, waiting }: { data: OverviewData | null; openConversation: (id: string) => void; waiting: number }) {
  const cards = data?.working ?? [];
  const chats = data?.chats ?? [];
  return (
    <section aria-labelledby="ws-now-h" className="ws-now">
      <h2 id="ws-now-h" className="ws-h">Working right now {cards.length + chats.length > 0 && <span className="ws-count">{cards.length + chats.length}</span>}</h2>
      {chats.map((c) => (
        <button key={c.conversation} className="ws-card ws-job" onClick={() => openConversation(c.conversation)}>
          <span className="ws-job-top"><span className="ws-pulse" aria-hidden="true" /><strong>{c.agent}</strong><span className="ws-dim">in {c.where}</span></span>
        </button>
      ))}
      {cards.map((c) => (
        <article key={c.card} className="ws-card ws-job">
          <span className="ws-job-top"><span className="ws-pulse" aria-hidden="true" /><strong>{c.agent}</strong><span className="ws-dim" style={{ marginLeft: 'auto' }}>{when(c.since)}</span></span>
          <span className="ws-job-title">{c.title}</span>
          <span className="ws-job-foot"><span>{c.step}</span><span className="ws-chip">{c.vertical}</span></span>
        </article>
      ))}
      {data && !cards.length && !chats.length && (
        <div className="ws-empty">Nobody is working right now.{waiting ? ` ${waiting === 1 ? 'A card waits' : `${waiting} cards wait`} on you; ${waiting === 1 ? 'it starts' : 'they start'} here once you clear ${waiting === 1 ? 'it' : 'them'}.` : ''}</div>
      )}
    </section>
  );
}

/** The separately deployable parts: each with its stack, progress and who works on it. */
export function Verticals({ verticals, base }: { verticals: OverviewData['verticals']; base: string }) {
  if (!verticals.length) return null;
  return (
    <section aria-labelledby="ws-vert-h" className="ws-section">
      <h2 id="ws-vert-h" className="ws-h">Verticals</h2>
      <div className="ws-verticals">
        {verticals.map((v) => {
          const pct = v.total ? Math.round((v.done / v.total) * 100) : 0;
          return (
            <a key={v.id} className="ws-card ws-vertical" href={href(`/project/${v.id}/board`)} onClick={go(`/project/${v.id}/board`)}>
              <span className="ws-vertical-top"><strong>{v.name}</strong>{v.blocked > 0 && <span className="ws-alert">{v.blocked}</span>}</span>
              {v.description && <span className="ws-vertical-desc">{v.description}</span>}
              {v.technology && <span className="ws-mono">{v.technology}</span>}
              <span className="ws-vertical-foot">
                <span className="ws-bar-track"><span style={{ width: `${pct}%` }} /></span>
                <span className="ws-dim">{v.total ? `${v.done} of ${v.total} cards` : 'No cards yet'}{v.who.length ? ` · ${v.who.join(', ')}` : ''}</span>
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

/** This week's cost per day (API-equivalent), the plan's share, and builder time. */
export function Usage({ usage }: { usage: OverviewData['usage'] }) {
  const max = Math.max(...usage.week.map((d) => d.cost), 1);
  const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short' });
  const hours = Math.floor(usage.builderMs / 3_600_000);
  const mins = Math.round((usage.builderMs % 3_600_000) / 60_000);
  return (
    <section aria-labelledby="ws-usage-h" className="ws-section">
      <h2 id="ws-usage-h" className="ws-h">Usage this week</h2>
      <div className="ws-usage-total"><strong>${Math.round(usage.total).toLocaleString()}</strong><span className="ws-dim">API-equivalent · on your plan this is usage, not a bill</span></div>
      <figure className="ws-chart" aria-label="Cost per day this week">
        <div className="ws-bars">
          {usage.week.map((d) => (
            <span key={d.day} className="ws-bar-col" title={`${d.day}: $${d.cost.toFixed(2)}`}>
              {d.cost > 0 && <span className="ws-bar-val">${Math.round(d.cost)}</span>}
              <span className="ws-chart-bar" style={{ height: d.cost ? Math.max(4, Math.round((80 * d.cost) / max)) : 2, opacity: d.cost ? 1 : 0.35 }} />
            </span>
          ))}
        </div>
        <div className="ws-bar-days">{usage.week.map((d) => <span key={d.day}>{day(d.day)}</span>)}</div>
      </figure>
      {usage.planPct !== null && (
        <div className="ws-kv"><span>Your plan this week, all projects</span><span>{usage.planPct}%</span></div>
      )}
      {usage.planPct !== null && <span className="ws-bar-track"><span style={{ width: `${usage.planPct}%`, background: 'var(--g-fg)' }} /></span>}
      <div className="ws-kv"><span>Builder runs</span><span>{usage.builderRuns}{usage.builderMs ? ` · ${hours ? `${hours} h ` : ''}${mins} m` : ''}</span></div>
    </section>
  );
}
