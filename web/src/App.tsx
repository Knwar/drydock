import { useEffect, useState } from 'react';
import { useApi } from './lib/api';
import { closeSettings, navigate, openSettings, settingsParam, threadParam, usePath } from './lib/router';
import { useTheme } from './lib/theme';
import type { Conversation, IdeaCard, ProjectSummary, Role, WorkspaceInfo } from './lib/types';
import { ChatPanel } from './components/Chat';
import { CommandBar } from './components/CommandBar';
import { Header, Sidebar } from './components/Shell';
import { AddMemberDialog, NewProjectDialog, NewThreadDialog } from './components/Dialogs';
import { ImportDialog } from './components/ImportDialog';
import { RightRail } from './components/RightRail';
import { TeamList } from './components/Team';
import { Home } from './pages/Home';
import { Onboarding } from './pages/Onboarding';
import { Personal } from './pages/Personal';
import { ProjectPage } from './pages/ProjectPage';
import { IdeaPage } from './pages/IdeaPage';
import { CaptureIdeaDialog, ideaEvents } from './components/Ideas';
import { SettingsWindow } from './pages/Settings';

const projectEvents = (m: any) => ['card', 'card_removed', 'phases', 'project_removed', 'workspace', 'brain_project', 'design'].includes(m?.type);
const convEvents = (m: any) => ['chat', 'chat_status', 'conversations', 'roles', 'chat_update'].includes(m?.type);

function useStored(key: string, initial: string): [string, (v: string) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* private mode */
    }
  }, [key, v]);
  return [v, setV];
}

export function App() {
  const [theme, toggleTheme] = useTheme();
  const parts = usePath();
  const path = '/' + parts.join('/');
  const settings = settingsParam();
  // old /settings/<section> addresses open the settings window over Home
  useEffect(() => {
    if (parts[0] !== 'settings') return;
    const section = parts[1] ?? 'integrations';
    navigate(`/?settings=${encodeURIComponent(section)}`, { replace: true });
  }, [parts[0], parts[1]]);
  const ws = useApi<WorkspaceInfo>('/api/workspace', (m) => m?.type === 'workspace');
  const ready = Boolean(ws.data?.configured);
  const profile = useApi<{ name: string | null }>('/api/profile', (m) => m?.type === 'profile');
  const projects = useApi<ProjectSummary[]>(ready ? '/api/projects' : null, projectEvents);
  const roles = useApi<Role[]>(ready ? '/api/roles' : null, (m) => m?.type === 'roles');
  const convs = useApi<Conversation[]>(ready ? '/api/conversations' : null, convEvents);
  const ideas = useApi<IdeaCard[]>(ready ? '/api/ideas' : null, ideaEvents);
  const [capturing, setCapturing] = useState(false);
  const [convId, setConvId] = useStored('ai-brain-conversation', 'dm:main');
  const [chatState, setChatState] = useStored('ai-brain-chat', 'open');
  const [newProject, setNewProject] = useState(false);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState<string | undefined>();
  const [newThread, setNewThread] = useState<{ project: string | null } | null>(null);
  const [addingMember, setAddingMember] = useState(false);
  // Project pages use the full width. The chat/glance panel docks on the
  // Overview tab only when the user expands it; on other tabs it slides over
  // the content when opened and goes away on the next navigation.
  const [projectSide, setProjectSide] = useStored('ai-brain-project-side', 'closed');
  const linked = threadParam();
  const [drawer, setDrawer] = useState(() => Boolean(linked));
  useEffect(() => setDrawer(Boolean(linked)), [path, linked]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal-back') && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);
  const [cmd, setCmd] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') (e.preventDefault(), setCmd((v) => !v));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (ws.error) return <main className="main"><div className="error">Can't reach the AI Brain daemon: {ws.error}</div></main>;
  if (!ws.data) return null;
  if (!ready) return <Onboarding onDone={() => { ws.reload(); profile.reload(); }} />;

  const list = projects.data ?? [];
  const conversations = convs.data ?? [];
  const current = conversations.find((c) => c.id === (linked ?? convId)) ?? conversations.find((c) => c.id === 'dm:main') ?? null;
  const onProject = parts[0] === 'project' && Boolean(parts[1]);
  const onOverview = onProject && !parts[2];
  // an idea page has its own chat beside it
  const onIdea = parts[0] === 'idea' && Boolean(parts[1]);
  const sideOpen = !onIdea && (!onProject || (onOverview ? projectSide === 'open' || Boolean(linked) : drawer));
  const setSide = (open: boolean) => {
    if (onOverview) setProjectSide(open ? 'open' : 'closed');
    else setDrawer(open);
    if (!open && linked) navigate(path);
  };
  /** Open an app path; a ?thread= in it opens that thread in the chat panel. */
  const openLink = (link: string) => {
    if (link.startsWith('/settings')) return openSettings(link.split('/')[2] || 'integrations');
    const thread = new URL(link, location.origin).searchParams.get('thread');
    if (thread) (setConvId(thread), setChatState('open'));
    navigate(link);
  };
  const select = (id: string) => {
    setConvId(id);
    if (threadParam() !== id) navigate(`${path === '/' ? '' : path}?thread=${encodeURIComponent(id)}`);
    setChatState('open');
    if (onProject) setSide(true);
    convs.reload();
  };
  const askMain = (text: string) => {
    select('dm:main');
    if (text) setDraft(text);
  };

  let page: React.ReactNode;
  if (parts.length === 0) page = <Home projects={list} onImport={() => setImporting(true)} />;
  else if (parts[0] === 'project' && parts[1])
    page = <ProjectPage key={parts[1]} id={parts[1]} tab={parts[2] ?? ''} sub={parts[3] ?? null} roles={roles.data ?? []} openConversation={select} newThread={() => setNewThread({ project: parts[1] })} side={{ open: sideOpen, toggle: () => setSide(!sideOpen) }} />;
  else if (onIdea) page = <IdeaPage key={parts[1]} id={parts[1]} tab={parts[2] ?? ''} sub={parts[3] ?? null} roles={roles.data ?? []} conversations={conversations} projects={list} />;
  else if (parts[0] === 'personal') page = <Personal />;
  else page = <div className="empty">Not found. <a href="/app/">Go home</a></div>;

  return (
    <div className="app">
      <Header theme={theme} toggleTheme={toggleTheme} name={profile.data?.name ?? ''} onSearch={() => setCmd(true)} />
      <div className="body">
        <Sidebar
          key={list.length ? 'loaded' : 'empty'}
          projects={list}
          path={path}
          mainOn={chatState === 'open' && sideOpen && current?.id === 'dm:main'}
          onMain={() => select('dm:main')}
          mainWorking={Boolean(conversations.find((c) => c.id === 'dm:main')?.working)}
          onNewProject={() => setNewProject(true)}
          ideas={ideas.data ?? []}
          onNewIdea={() => setCapturing(true)}
          settingsOpen={Boolean(settings)}
          threads={{ conversations, current: chatState === 'open' && sideOpen ? current?.id ?? null : null, open: select, newThread: (project) => setNewThread({ project }) }}
        >
          <TeamList conversations={conversations} roles={roles.data ?? []} current={chatState === 'open' && sideOpen ? current?.id ?? null : null} select={select} onNewThread={() => setNewThread({ project: null })} />
        </Sidebar>
        <main className={`main${onIdea ? ' main-idea' : ''}`}>{page}</main>
        {sideOpen && (
          <div className={onProject && !onOverview ? 'side-drawer' : 'side-dock'}>
            {chatState === 'open' ? (
              <ChatPanel conversation={current} roles={roles.data ?? []} projects={list} onSent={convs.reload} onClose={() => (onProject ? setSide(false) : setChatState('closed'))} draftText={draft} onDraftUsed={() => setDraft(undefined)} />
            ) : (
              <RightRail roles={roles.data ?? []} conversations={conversations} open={select} onExpand={() => setChatState('open')} onHide={onProject ? () => setSide(false) : undefined} />
            )}
          </div>
        )}
        {settings && <SettingsWindow section={settings} roles={roles.data ?? []} onClose={closeSettings} />}
        {capturing && <CaptureIdeaDialog onClose={() => setCapturing(false)} />}
        {newProject && <NewProjectDialog onClose={() => setNewProject(false)} askMain={askMain} onImport={() => (setNewProject(false), setImporting(true))} />}
        {importing && <ImportDialog onClose={() => setImporting(false)} onImported={(id, channel) => (setImporting(false), openLink(`/project/${id}?thread=${encodeURIComponent(channel)}`))} />}
        {newThread && (
          <NewThreadDialog
            roles={roles.data ?? []}
            projects={list.map((p) => ({ id: p.id, name: p.name }))}
            defaultProject={newThread.project}
            onClose={() => setNewThread(null)}
            onCreated={select}
            onAddMember={() => (setNewThread(null), setAddingMember(true))}
          />
        )}
        {cmd && (
          <CommandBar
            projects={list}
            conversations={conversations}
            roles={roles.data ?? []}
            onClose={() => setCmd(false)}
            openLink={openLink}
            actions={{
              newIdea: () => setCapturing(true),
              newProject: () => setNewProject(true),
              importProject: () => setImporting(true),
              newThread: () => setNewThread({ project: onProject ? parts[1] : null }),
              addMember: () => setAddingMember(true),
              toggleTheme,
              askMain,
            }}
          />
        )}
        {addingMember && <AddMemberDialog onClose={() => setAddingMember(false)} onAdded={() => setAddingMember(false)} />}
      </div>
    </div>
  );
}
