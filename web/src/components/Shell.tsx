import { useState } from 'react';
import { useApi } from '../lib/api';
import { go, href } from '../lib/router';
import { STAGE_LABEL, type ProjectSummary } from '../lib/types';
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
  badge?: { text: string; tone: string };
  children?: TreeNode[];
  bold?: boolean;
}

function projectTree(p: ProjectSummary): TreeNode {
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
    badge: { text: p.blocked ? 'Blocked' : STAGE_LABEL[p.stage], tone: p.blocked ? 't-r' : STAGE_TONE[p.stage] },
    children: [
      { id: `${p.id}/overview`, label: 'Overview', icon: 'overview', to: base },
      { id: `${p.id}/req`, label: 'Requirements', icon: 'doc', to: `${base}/requirements` },
      design,
      { id: `${p.id}/board`, label: p.phase ? `Board · phase ${p.phase.index}/${p.phase.count}` : 'Board', icon: 'board', to: `${base}/board`, badge: p.cards.total ? { text: `${p.cards.done}/${p.cards.total}`, tone: 't-n' } : undefined },
      { id: `${p.id}/roles`, label: 'Roles', icon: 'role', to: `${base}/roles` },
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
        const on = n.to !== undefined && n.to === current;
        return (
          <div key={n.id}>
            <a
              className={`nav-row${on ? ' on' : ''}`}
              style={{ paddingLeft: 6 + depth * 14, fontWeight: n.bold ? 600 : undefined }}
              href={n.to ? href(n.to) : '#'}
              aria-expanded={kids ? isOpen : undefined}
              onClick={(e) => {
                if (kids) toggle(n.id);
                if (n.to) go(n.to)(e);
                else e.preventDefault();
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

export function Sidebar({ projects, path, children, mainOn, onMain, mainWorking, onNewProject }: { projects: ProjectSummary[]; path: string; children?: React.ReactNode; mainOn: boolean; onMain: () => void; mainWorking: boolean; onNewProject: () => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(projects[0] ? [projects[0].id] : []));
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));
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
          <TreeRows nodes={projects.map(projectTree)} depth={0} open={open} toggle={toggle} current={path} />
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
    <div className="steps" aria-label={`Stage: ${stage}`}>
      {order.map((s, i) => (
        <span key={s} title={s} className={`step${i < cur ? ' done' : i === cur ? ' cur' : ''}`} />
      ))}
    </div>
  );
}
