import { useState } from 'react';
import { useApi } from '../lib/api';
import { go, href } from '../lib/router';
import { STAGE_LABEL, type Conversation, type ProjectSummary } from '../lib/types';
import { Icon, type IconName } from './Icon';

const STAGE_TONE: Record<string, string> = { build: 't-g', design: 't-v', plan: 't-b', requirements: 't-a', create: 't-n', idea: 't-n' };

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Header({ theme, toggleTheme, name }: { theme: string; toggleTheme: () => void; name: string }) {
  const now = new Date();
  const stamp = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <header className="app-header">
      <a className="brand" href={href('/')} onClick={go('/')}>
        <span className="brand-mark" aria-hidden="true">AB</span>
        <span className="brand-name">AI Brain</span>
      </a>
      <div className="greeting">
        <div className="eyebrow">{stamp}</div>
        <h1>
          {greeting(now)}
          {name ? `, ${name}` : ''}
        </h1>
      </div>
      <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" style={{ color: 'var(--muted)' }} />
        <label htmlFor="cmd" className="sr-only">
          Search or run a command
        </label>
        <input id="cmd" placeholder="Search projects, docs, people, or run a command…" />
        <span className="kbd">⌘K</span>
      </form>
      <UsageMeter />
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
    <a className={`usage${u.data?.high ? ' high' : ''}`} href={href('/settings/usage')} onClick={go('/settings/usage')} style={{ textDecoration: 'none' }} title="Claude subscription usage this week">
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
  badge?: { text: string; tone: string };
  children?: TreeNode[];
  bold?: boolean;
  quiet?: boolean;
}

/** A project thread's name inside its project (older stage threads carried the project slug). */
export const threadName = (c: Conversation, slug?: string) => (slug && c.name.startsWith(`${slug}-`) ? c.name.slice(slug.length + 1) : c.name);

interface ThreadCtx {
  conversations: Conversation[];
  current: string | null;
  open: (id: string) => void;
  newThread: (projectId: string | null) => void;
}

function projectTree(p: ProjectSummary, t: ThreadCtx): TreeNode {
  const slug = p.root.split('/').pop();
  const threads = t.conversations.filter((c) => c.kind === 'channel' && c.project_id === p.id);
  const unread = threads.reduce((n, c) => n + c.unread, 0);
  const discussions: TreeNode = {
    id: `${p.id}/discussions`,
    label: 'Discussions',
    icon: 'chat',
    badge: unread ? { text: String(unread), tone: 't-b' } : threads.some((c) => c.working) ? { text: 'live', tone: 't-g' } : undefined,
    children: [
      ...threads.map((c) => ({
        id: c.id,
        label: `# ${threadName(c, slug)}`,
        icon: 'chat' as IconName,
        onSelect: () => t.open(c.id),
        active: t.current === c.id,
        badge: c.unread ? { text: String(c.unread), tone: 't-b' } : c.working ? { text: 'live', tone: 't-g' } : undefined,
      })),
      { id: `${p.id}/new-thread`, label: 'New thread', icon: 'plus' as IconName, onSelect: () => t.newThread(p.id), quiet: true },
    ],
  };
  const base = `/project/${p.id}`;
  const design: TreeNode = {
    id: `${p.id}/design`,
    label: 'System design',
    icon: 'diagram',
    to: `${base}/design`,
    children: p.containers.map((c) => {
      const v = p.verticals.find((x) => x.name === c.name);
      return {
        id: `${p.id}/c/${c.id}`,
        label: c.name,
        icon: 'vertical' as IconName,
        to: c.components ? `${base}/design/${c.id}` : `${base}/design`,
        badge: v?.total ? { text: `${Math.round((v.done / v.total) * 100)}%`, tone: 't-n' } : undefined,
      };
    }),
  };
  return {
    id: p.id,
    label: p.name,
    icon: 'project',
    bold: true,
    badge:
      p.status === 'closed' ? { text: 'Closed', tone: 't-n' }
      : p.status === 'paused' ? { text: 'Paused', tone: 't-a' }
      : p.status === 'review' ? { text: 'Close-out', tone: 't-v' }
      : { text: p.blocked ? 'Blocked' : STAGE_LABEL[p.stage], tone: p.blocked ? 't-r' : STAGE_TONE[p.stage] },
    children: [
      { id: `${p.id}/overview`, label: 'Overview', icon: 'overview', to: base },
      { id: `${p.id}/req`, label: 'Requirements', icon: 'doc', to: `${base}/requirements` },
      design,
      { id: `${p.id}/board`, label: p.phase ? `Board · phase ${p.phase.index}/${p.phase.count}` : 'Board', icon: 'board', to: `${base}/board`, badge: p.cards.total ? { text: `${p.cards.done}/${p.cards.total}`, tone: 't-n' } : undefined },
      discussions,
      { id: `${p.id}/roles`, label: 'Team', icon: 'role', to: `${base}/roles` },
      { id: `${p.id}/memory`, label: 'Memory', icon: 'doc', to: `${base}/memory` },
      { id: `${p.id}/agents`, label: 'Live agents', icon: 'agent', to: `${base}/agents`, badge: p.liveAgents ? { text: String(p.liveAgents), tone: 't-g' } : undefined },
      { id: `${p.id}/docs`, label: 'Docs', icon: 'vault', to: `${base}/docs` },
    ],
  };
}

function TreeRows({ nodes, depth, open, toggle, current }: { nodes: TreeNode[]; depth: number; open: Set<string>; toggle: (id: string) => void; current: string }) {
  return (
    <>
      {nodes.map((n) => {
        const kids = Boolean(n.children?.length);
        const isOpen = open.has(n.id);
        const on = n.active ?? (n.to !== undefined && n.to === current);
        return (
          <div key={n.id}>
            <a
              className={`nav-row${on ? ' on' : ''}`}
              style={{ paddingLeft: 6 + depth * 14, fontWeight: n.bold ? 600 : undefined, color: n.quiet ? 'var(--muted)' : undefined }}
              href={n.to ? href(n.to) : '#'}
              aria-expanded={kids ? isOpen : undefined}
              onClick={(e) => {
                if (kids) toggle(n.id);
                if (n.to) go(n.to)(e);
                else e.preventDefault();
                n.onSelect?.();
              }}
            >
              <Icon name="chevron" size={12} className={`chev${kids ? (isOpen ? ' open' : '') : ' none'}`} />
              <Icon name={n.icon} size={15} style={{ flex: '0 0 15px', color: n.icon === 'project' ? 'var(--accent)' : 'var(--muted)' }} />
              <span className="label">{n.label}</span>
              {n.badge && <span className={`pill ${n.badge.tone}`} style={{ fontSize: 10.5 }}>{n.badge.text}</span>}
            </a>
            {kids && isOpen && <TreeRows nodes={n.children!} depth={depth + 1} open={open} toggle={toggle} current={current} />}
          </div>
        );
      })}
    </>
  );
}

export function Sidebar({ projects, path, children, mainOn, onMain, mainWorking, onNewProject, threads }: { projects: ProjectSummary[]; path: string; children?: React.ReactNode; mainOn: boolean; onMain: () => void; mainWorking: boolean; onNewProject: () => void; threads: ThreadCtx }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(projects[0] ? [projects[0].id] : []));
  const toggle = (id: string) => setOpen((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <nav className="sidebar" aria-label="Main">
      <button className={`nav-row${mainOn ? ' on' : ''}`} onClick={onMain} style={{ fontWeight: 600, fontSize: 14, padding: '8px 10px' }}>
        <span className="avatar" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>M</span>
        <span className="label">Main agent</span>
        <span className="dot" style={{ background: mainWorking ? 'var(--g-fg)' : 'var(--n-fg)' }} title={mainWorking ? 'working' : 'idle'} />
      </button>
      <div>
        <div className="side-label">
          <span>PROJECTS</span>
          <button aria-label="New project" title="New project" onClick={onNewProject}>
            +
          </button>
        </div>
        {projects.length ? (
          <TreeRows nodes={projects.map((p) => projectTree(p, threads))} depth={0} open={open} toggle={toggle} current={path} />
        ) : (
          <div className="muted" style={{ fontSize: 12.5, padding: '4px 10px' }}>
            No projects yet. <button className="link-btn" style={{ color: 'var(--accent)', fontSize: 12.5 }} onClick={onNewProject}>Start one</button> or describe an idea to the Main agent.
          </div>
        )}
      </div>
      {children}
      <div className="side-foot">
        <a className={`nav-row${path === '/personal' ? ' on' : ''}`} href={href('/personal')} onClick={go('/personal')}>
          <Icon name="person" /> <span className="label">Personal</span>
        </a>
        <a className={`nav-row${path.startsWith('/settings') ? ' on' : ''}`} href={href('/settings')} onClick={go('/settings')}>
          <Icon name="settings" /> <span className="label">Settings</span>
        </a>
      </div>
    </nav>
  );
}

export function StageSteps({ stage }: { stage: string }) {
  const order = ['idea', 'create', 'requirements', 'design', 'plan', 'build'];
  const cur = order.indexOf(stage);
  return (
    <div className="steps" aria-label={`Stage: ${stage}, ${cur + 1} of ${order.length}`}>
      {order.map((s, i) => (
        <span key={s} title={s[0].toUpperCase() + s.slice(1)} className={`step${i < cur ? ' done' : i === cur ? ' cur' : ''}`} />
      ))}
      {cur >= 0 && <span className="muted" style={{ fontSize: 11.5, marginLeft: 4 }}>{cur + 1} of {order.length}</span>}
    </div>
  );
}
