import { useEffect, useState } from 'react';
import { useApi } from '../lib/api';
import { go, href, openSettings } from '../lib/router';
import { STAGE_LABEL, type Conversation, type IdeaCard, type ProjectSummary } from '../lib/types';
import { Icon, type IconName } from './Icon';
import { LiveCount } from './LiveCard';
import { PLUGIN_META } from './CommandBar';

const STAGE_TONE: Record<string, string> = { build: 't-g', design: 't-v', plan: 't-b', requirements: 't-a', create: 't-n', idea: 't-n' };

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Header({ theme, toggleTheme, name, onSearch, messages }: { theme: string; toggleTheme: () => void; name: string; onSearch: () => void; messages: { open: boolean; unread: number; toggle: () => void } }) {
  const now = new Date();
  const stamp = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <header className="app-header">
      <a className="brand" href={href('/')} onClick={go('/')}>
        <span className="brand-mark" aria-hidden="true">DD</span>
        <span className="brand-name">Drydock</span>
      </a>
      <div className="greeting">
        <div className="eyebrow">{stamp}</div>
        <h1>
          {greeting(now)}
          {name ? `, ${name}` : ''}
        </h1>
      </div>
      <button className="search" onClick={onSearch} aria-label="Search or run a command (⌘K)">
        <Icon name="search" style={{ color: 'var(--muted)' }} />
        <span className="search-ph">Search projects, docs, people, or run a command…</span>
        <span className="kbd">⌘K</span>
      </button>
      <LiveCount />
      <UsageMeter />
      <button className={`icon-btn msg-toggle${messages.open ? ' on' : ''}`} onClick={messages.toggle} aria-pressed={messages.open} aria-label={`Messages${messages.unread ? `, ${messages.unread} unread` : ''}`} title="Messages">
        <Icon name="chat" size={18} />
        {messages.unread > 0 && <span className="badge">{messages.unread > 99 ? '99+' : messages.unread}</span>}
      </button>
      <button className="icon-btn" onClick={toggleTheme} aria-label={label} title={label}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
      </button>
    </header>
  );
}

function UsageMeter() {
  const u = useApi<{ five_hour: { pct: number } | null; seven_day: { pct: number } | null; threshold: number; high: boolean }>('/api/usage', (m) => m?.type === 'usage');
  const week = u.data?.seven_day;
  return (
    <a className={`usage${u.data?.high ? ' high' : ''}`} href={href('/?settings=usage')} onClick={(e) => (e.preventDefault(), openSettings('usage'))} style={{ textDecoration: 'none' }} title="Claude subscription usage this week">
      <div className="usage-top">
        <span style={{ fontWeight: 600, color: u.data?.high ? 'var(--a-fg)' : 'var(--muted)' }}>{u.data?.high ? 'Usage high' : 'Usage this week'}</span>
        <span className="mono">{week ? `${week.pct}%` : '—'}</span>
      </div>
      <div className="bar" style={{ height: 5 }}><div style={{ width: `${week?.pct ?? 0}%`, background: u.data?.high ? 'var(--a-fg)' : 'var(--accent)' }} /></div>
    </a>
  );
}

interface TreeNode {
  id: string;
  label: string;
  icon: IconName;
  to?: string;
  /** an action instead of navigation (open a thread, start one) */
  onSelect?: () => void;
  active?: boolean;
  /** the thread open in the chat panel */
  thread?: boolean;
  badge?: { text: string; tone: string };
  children?: TreeNode[];
  bold?: boolean;
  quiet?: boolean;
}

/** A project thread's name inside its project (older stage threads carried the project slug). */
export const threadName = (c: Conversation, slug?: string) => (slug && c.name.startsWith(`${slug}-`) ? c.name.slice(slug.length + 1) : c.name);


function projectTree(p: ProjectSummary, path: string): TreeNode {
  const base = `/project/${p.id}`;
  return {
    id: p.id,
    label: p.name,
    icon: 'project',
    bold: true,
    to: base,
    active: path === base || path.startsWith(`${base}/`),
    badge:
      p.status === 'closed' ? { text: 'Closed', tone: 't-n' }
      : p.status === 'paused' ? { text: 'Paused', tone: 't-a' }
      : p.status === 'review' ? { text: 'Close-out', tone: 't-v' }
      : { text: p.blocked ? 'Blocked' : STAGE_LABEL[p.stage], tone: p.blocked ? 't-r' : STAGE_TONE[p.stage] },
    children: [
      // the project's discussions are in the messenger
      ...(p.plugins ?? []).flatMap((id) => {
        const m = PLUGIN_META[id];
        return m ? [{ id: `${p.id}/plugin/${id}`, label: m.name, icon: m.icon, to: `${base}/${id}`, active: path === `${base}/${id}` || path.startsWith(`${base}/${id}/`) }] : [];
      }),
    ],
  };
}

function TreeRows({ nodes, depth, open, toggle }: { nodes: TreeNode[]; depth: number; open: Set<string>; toggle: (id: string) => void }) {
  return (
    <>
      {nodes.map((n) => {
        const kids = Boolean(n.children?.length);
        const isOpen = open.has(n.id);
        return (
          <div key={n.id} className={depth ? 'tree-kid' : undefined}>
            <div className="tree-row" style={{ paddingLeft: depth * 14 }}>
              {kids ? (
                <button className="chev-btn" aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${n.label}`} aria-expanded={isOpen} onClick={() => toggle(n.id)}>
                  <Icon name="chevron" size={12} className={`chev${isOpen ? ' open' : ''}`} />
                </button>
              ) : (
                <span className="chev-btn" aria-hidden="true" />
              )}
              <a
                className={`nav-row${n.active ? ' on' : ''}${n.thread ? ' open-thread' : ''}`}
                style={{ fontWeight: n.bold ? 600 : undefined, color: n.quiet ? 'var(--muted)' : undefined }}
                href={n.to ? href(n.to) : '#'}
                title={n.label}
                aria-current={n.active ? 'page' : undefined}
                onClick={(e) => {
                  if (n.to) go(n.to)(e);
                  else e.preventDefault();
                  n.onSelect?.();
                }}
              >
                <Icon name={n.icon} size={15} style={{ flex: '0 0 15px', color: n.icon === 'project' ? 'var(--accent)' : 'var(--muted)' }} />
                <span className="label">{n.label}</span>
                {n.badge && <span className={`pill ${n.badge.tone}`} style={{ fontSize: 10.5 }}>{n.badge.text}</span>}
              </a>
            </div>
            {kids && isOpen && <TreeRows nodes={n.children!} depth={depth + 1} open={open} toggle={toggle} />}
          </div>
        );
      })}
    </>
  );
}

export function Sidebar({ projects, path, mainOn, onMain, mainWorking, onNewProject, ideas, onNewIdea, settingsOpen }: { projects: ProjectSummary[]; path: string; mainOn: boolean; onMain: () => void; mainWorking: boolean; onNewProject: () => void; ideas: IdeaCard[]; onNewIdea: () => void; settingsOpen: boolean }) {
  const active = ideas.filter((i) => i.status !== 'parked' && i.status !== 'promoted');
  const parked = ideas.length - active.length;
  const [open, setOpen] = useState<Set<string>>(() => new Set(projects[0] ? [projects[0].id] : []));
  const toggle = (id: string) => setOpen((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // the project you are on shows its threads
  const here = path.match(/^\/project\/([^/]+)/)?.[1];
  useEffect(() => {
    if (here) setOpen((s) => (s.has(here) ? s : new Set(s).add(here)));
  }, [here]);
  // small screens: the icon rail expands on hover and folds away again once you pick something
  const [hold, setHold] = useState(false);
  return (
    <nav className={`sidebar${hold ? ' hold' : ''}`} aria-label="Main" onClickCapture={() => setHold(true)} onMouseLeave={() => setHold(false)}>
      {/* everything scrolls except Personal and Settings, which stay at the bottom */}
      <div className="side-scroll">
        <button className={`nav-row${mainOn ? ' on' : ''}`} onClick={onMain} style={{ fontWeight: 600, fontSize: 14, padding: '8px 10px' }}>
          <span className="avatar" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>M</span>
          <span className="label">Main agent</span>
          <span className="dot" style={{ background: mainWorking ? 'var(--g-fg)' : 'var(--n-fg)' }} title={mainWorking ? 'working' : 'idle'} />
        </button>
        <div>
          <div className="side-label">
            <span>IDEAS</span>
            <button aria-label="New idea" title="New idea" onClick={onNewIdea}>
              +
            </button>
          </div>
          {active.length ? (
            <TreeRows
              nodes={active.map((i) => ({
                id: i.id,
                label: i.title,
                icon: 'idea' as IconName,
                to: `/idea/${i.id}`,
                active: path === `/idea/${i.id}` || path.startsWith(`/idea/${i.id}/`),
                badge: i.working ? { text: 'live', tone: 't-g' } : i.status === 'raw' ? { text: 'New', tone: 't-n' } : undefined,
              }))}
              depth={0}
              open={open}
              toggle={toggle}
            />
          ) : (
            <div className="muted side-note" style={{ fontSize: 12.5, padding: '4px 10px' }}>Ideas you mention to the Main agent land here.</div>
          )}
          {parked > 0 && <a className="nav-row muted side-note" style={{ fontSize: 12 }} href={href('/')} onClick={go('/')}><span className="chev-btn" aria-hidden="true" /><span className="label">{parked} parked on the board</span></a>}
        </div>
        <div>
          <div className="side-label">
            <span>PROJECTS</span>
            <button aria-label="New project" title="New project" onClick={onNewProject}>
              +
            </button>
          </div>
          {projects.length ? (
            <TreeRows nodes={projects.map((p) => projectTree(p, path))} depth={0} open={open} toggle={toggle} />
          ) : (
            <div className="muted side-note" style={{ fontSize: 12.5, padding: '4px 10px' }}>
              No projects yet. <button className="link-btn" style={{ color: 'var(--accent)', fontSize: 12.5 }} onClick={onNewProject}>Start one</button> or describe an idea to the Main agent.
            </div>
          )}
        </div>
      </div>
      <div className="side-foot">
        <a className={`nav-row${path === '/personal' ? ' on' : ''}`} href={href('/personal')} onClick={go('/personal')}>
          <Icon name="person" /> <span className="label">Personal</span>
        </a>
        <a className={`nav-row${settingsOpen ? ' on' : ''}`} href={href('/?settings=integrations')} onClick={(e) => (e.preventDefault(), openSettings())}>
          <Icon name="settings" /> <span className="label">Settings</span>
        </a>
      </div>
    </nav>
  );
}

const STAGE_TITLES: Record<string, string> = { idea: 'Idea', create: 'Set up', requirements: 'Requirements', design: 'Design', plan: 'Plan', build: 'Build' };

/** Where a project is in its life: every stage named, done ones ticked, the current one highlighted (compact: just the current one). */
export function StageSteps({ stage, type, compact }: { stage: string; type?: string; compact?: boolean }) {
  const order = type === 'general' ? ['idea', 'create', 'requirements', 'plan', 'build'] : ['idea', 'create', 'requirements', 'design', 'plan', 'build'];
  const cur = order.indexOf(stage);
  if (compact)
    return (
      <div className="stage-now" title={order.map((s, i) => `${i < cur ? '✓' : i === cur ? '●' : '○'} ${STAGE_TITLES[s]}`).join('\n')}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{STAGE_TITLES[stage] ?? stage}</span>
        {cur >= 0 && <span className="muted" style={{ fontSize: 11.5 }}>Stage {cur + 1} of {order.length}</span>}
      </div>
    );
  return (
    <ol className="stages" aria-label="Project stages">
      {order.map((s, i) => (
        <li key={s} className={i < cur ? 'done' : i === cur ? 'cur' : undefined} aria-current={i === cur ? 'step' : undefined}>
          {i < cur && <span aria-hidden="true">✓ </span>}
          {STAGE_TITLES[s]}
        </li>
      ))}
    </ol>
  );
}
