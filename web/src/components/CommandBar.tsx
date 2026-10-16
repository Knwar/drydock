// The ⌘K command bar: jump anywhere, run a quick action, or search content.
// Anything else goes to the Main agent as a draft (never sent on its own).
// Consequential actions (stage gates, pause/close, removals) are deliberately
// not here: they stay on their pages behind confirmations.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Conversation, ProjectSummary, Role } from '../lib/types';
import { Icon, type IconName } from './Icon';

export const PROJECT_TABS = [
  ['', 'Overview'],
  ['requirements', 'Requirements'],
  ['design', 'System design'],
  ['board', 'Board'],
  ['roles', 'Team'],
  ['memory', 'Memory'],
  ['agents', 'Live agents'],
  ['docs', 'Docs'],
] as const;

export const SETTINGS_SECTIONS = [
  ['integrations', 'Integrations'],
  ['daily', 'The Daily'],
  ['team', 'Team & permissions'],
  ['secrets', 'Secrets'],
  ['usage', 'Usage alerts'],
  ['checkins', 'Check-ins'],
  ['workspace', 'Workspace'],
] as const;

interface Hit {
  type: string;
  title: string;
  snippet: string;
  project: string | null;
  link: string;
}

/** What a recent entry needs to run again: a link to open. */
interface Recent {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  link: string;
}

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void;
  /** links are remembered as recent */
  link?: string;
}

const HIT_GROUP: Record<string, [string, IconName]> = {
  requirements: ['Requirements', 'doc'],
  design: ['System design', 'diagram'],
  card: ['Cards', 'board'],
  decision: ['Decisions', 'doc'],
  lesson: ['Lessons', 'doc'],
  message: ['Messages', 'chat'],
  doc: ['Docs', 'vault'],
  note: ['Notes', 'doc'],
  reminder: ['Reminders', 'doc'],
};

const RECENT_KEY = 'ai-brain-recent';
const readRecent = (): Recent[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
};
const remember = (r: Recent) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([r, ...readRecent().filter((x) => x.id !== r.id)].slice(0, 6)));
  } catch {
    /* private mode */
  }
};

/** 0 = starts with the query, 1 = a word starts with it, 2 = contains every word, -1 = no match. */
function rank(label: string, q: string): number {
  const l = label.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.every((w) => l.includes(w))) return -1;
  if (l.startsWith(words[0])) return 0;
  if (l.split(/[\s›#·/-]+/).some((w) => w.startsWith(words[0]))) return 1;
  return 2;
}

export function CommandBar({ projects, conversations, roles, onClose, openLink, actions }: {
  projects: ProjectSummary[];
  conversations: Conversation[];
  roles: Role[];
  onClose: () => void;
  openLink: (link: string) => void;
  actions: { newProject: () => void; newThread: () => void; addMember: () => void; toggleTheme: () => void; askMain: (text: string) => void };
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const query = q.trim();

  useEffect(() => inputRef.current?.focus(), []);
  // content search, debounced
  useEffect(() => {
    setHits(null);
    if (query.length < 2) return;
    let alive = true;
    const t = setTimeout(() => {
      api<{ hits: Hit[] }>(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => alive && setHits(r.hits))
        .catch(() => alive && setHits([]));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const byRole = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  // every place you can jump to
  const places = useMemo(() => {
    const out: (Omit<Item, 'run' | 'group'> & { link: string })[] = [
      { id: 'home', label: 'Home', icon: 'overview', link: '/' },
      { id: 'personal', label: 'Personal', hint: 'email, calendar, notes, the Daily', icon: 'person', link: '/personal' },
      ...SETTINGS_SECTIONS.map(([id, label]) => ({ id: `settings/${id}`, label: `Settings › ${label}`, icon: 'settings' as IconName, link: `/settings/${id}` })),
    ];
    for (const p of projects)
      for (const [tab, label] of PROJECT_TABS)
        out.push({ id: `p/${p.id}/${tab}`, label: tab ? `${p.name} › ${label}` : p.name, hint: tab ? undefined : 'project', icon: tab ? 'doc' : 'project', link: `/project/${p.id}${tab ? `/${tab}` : ''}` });
    for (const c of conversations) {
      const project = c.project_id ? projects.find((p) => p.id === c.project_id) : null;
      const label = c.id === 'dm:main' ? 'Main agent' : c.kind === 'dm' ? `Chat with ${byRole.get(c.role_id ?? '')?.name ?? c.name}` : `#${c.name}`;
      const base = project ? `/project/${project.id}` : '/';
      out.push({ id: `t/${c.id}`, label, hint: project ? project.name : c.kind === 'channel' ? 'thread' : undefined, icon: 'chat', link: `${base}?thread=${encodeURIComponent(c.id)}` });
    }
    return out;
  }, [projects, conversations, byRole]);

  const doThen = (fn: () => void) => () => (onClose(), fn());
  const quick: Omit<Item, 'group'>[] = [
    { id: 'a/new-project', label: 'New project', icon: 'plus', run: doThen(actions.newProject) },
    { id: 'a/new-thread', label: 'New thread', icon: 'plus', run: doThen(actions.newThread) },
    { id: 'a/add-member', label: 'Add team member', icon: 'role', run: doThen(actions.addMember) },
    { id: 'a/theme', label: 'Switch light / dark theme', icon: 'moon', run: doThen(actions.toggleTheme) },
    {
      id: 'a/daily',
      label: "Generate today's Daily",
      hint: 'uses your subscription',
      icon: 'doc',
      run: () => {
        api('/api/daily/generate', { method: 'POST' }).catch(() => undefined);
        onClose();
        openLink('/personal');
      },
    },
  ];

  const items: Item[] = [];
  const go = (link: string, label: string, icon: IconName, hint?: string) => () => {
    remember({ id: link, label, hint, icon, link });
    onClose();
    openLink(link);
  };
  if (!query) {
    for (const r of readRecent()) items.push({ ...r, group: 'Recent', run: go(r.link, r.label, r.icon, r.hint) });
    for (const a of quick) items.push({ ...a, group: 'Actions' });
  } else {
    const jumps = places
      .map((p) => ({ p, r: rank(`${p.label} ${p.hint ?? ''}`, query) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.p.label.length - b.p.label.length)
      .slice(0, 8);
    for (const { p } of jumps) items.push({ ...p, group: 'Go to', run: go(p.link, p.label, p.icon, p.hint) });
    for (const a of quick) if (rank(a.label, query) >= 0) items.push({ ...a, group: 'Actions' });
    // within a group, hits whose title matches come first (the type order from the server is kept)
    const order = Object.keys(HIT_GROUP);
    const sorted = [...(hits ?? [])].sort((x, y) => order.indexOf(x.type) - order.indexOf(y.type) || Number(rank(y.title, query) >= 0) - Number(rank(x.title, query) >= 0));
    for (const h of sorted) {
      const [group, icon] = HIT_GROUP[h.type] ?? ['Results', 'doc'];
      items.push({ id: `h/${h.type}/${h.link}/${h.title}`, group, label: h.title, hint: [h.project, h.snippet].filter(Boolean).join(' · '), icon, run: go(h.link, h.title, icon, h.project ?? undefined) });
    }
    items.push({
      id: 'a/note',
      group: 'Actions',
      label: `Save “${query.length > 60 ? query.slice(0, 60) + '…' : query}” as a note`,
      icon: 'doc',
      run: () => {
        api('/api/notes', { body: { text: query } })
          .then(() => setNotice('Saved to notes.'))
          .catch((e) => setNotice((e as Error).message));
        setQ('');
      },
    });
    items.push({ id: 'a/ask', group: 'Ask', label: `Ask the Main agent: “${query.length > 70 ? query.slice(0, 70) + '…' : query}”`, hint: 'opens the chat with this as a draft', icon: 'chat', run: doThen(() => actions.askMain(query)) });
  }

  const sel = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => setActive(0), [query, hits]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((sel + 1) % Math.max(1, items.length)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((sel - 1 + items.length) % Math.max(1, items.length)));
    else if (e.key === 'Enter') (e.preventDefault(), items[sel]?.run());
    else if (e.key === 'Escape') (e.preventDefault(), onClose());
  };

  let lastGroup = '';
  return (
    <div className="modal-back cmd-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmd" role="dialog" aria-modal="true" aria-label="Command bar" onKeyDown={onKey}>
        <div className="cmd-input">
          <Icon name="search" style={{ color: 'var(--muted)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => (setQ(e.target.value), setNotice(null))}
            placeholder="Jump to, search, or ask…"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            aria-activedescendant={items[sel] ? `cmd-${sel}` : undefined}
            aria-label="Search or run a command"
          />
          <span className="kbd">esc</span>
        </div>
        {notice && <div className="banner t-g" style={{ margin: '0 12px', fontSize: 12.5 }}>{notice}</div>}
        <div className="cmd-list" id="cmd-list" role="listbox" ref={listRef}>
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id + i}>
                {head && <div className="cmd-group">{head}</div>}
                <div id={`cmd-${i}`} data-i={i} role="option" aria-selected={i === sel} className={`cmd-item${i === sel ? ' on' : ''}`} onMouseMove={() => i !== sel && setActive(i)} onClick={it.run}>
                  <Icon name={it.icon} size={15} style={{ flex: '0 0 15px', color: 'var(--muted)' }} />
                  <span className="cmd-label">{it.label}</span>
                  {it.hint && <span className="cmd-hint">{it.hint}</span>}
                </div>
              </div>
            );
          })}
          {query.length >= 2 && hits === null && <div className="cmd-group">Searching…</div>}
        </div>
        <div className="cmd-foot muted">↑↓ to move · ↵ to open · esc to close</div>
      </div>
    </div>
  );
}
