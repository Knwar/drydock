import { useEffect, useState } from 'react';
import { useApi } from './lib/api';
import { usePath } from './lib/router';
import { useTheme } from './lib/theme';
import type { Conversation, ProjectSummary, Role, WorkspaceInfo } from './lib/types';
import { ChatPanel } from './components/Chat';
import { Header, Sidebar } from './components/Shell';
import { NewProjectDialog } from './components/Dialogs';
import { RightRail } from './components/RightRail';
import { TeamList } from './components/Team';
import { Home } from './pages/Home';
import { Onboarding } from './pages/Onboarding';
import { Personal } from './pages/Personal';
import { ProjectPage } from './pages/ProjectPage';
import { Settings } from './pages/Settings';

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
  const ws = useApi<WorkspaceInfo>('/api/workspace', (m) => m?.type === 'workspace');
  const ready = Boolean(ws.data?.configured);
  const profile = useApi<{ name: string | null }>('/api/profile', (m) => m?.type === 'profile');
  const projects = useApi<ProjectSummary[]>(ready ? '/api/projects' : null, projectEvents);
  const roles = useApi<Role[]>(ready ? '/api/roles' : null, (m) => m?.type === 'roles');
  const convs = useApi<Conversation[]>(ready ? '/api/conversations' : null, convEvents);
  const [convId, setConvId] = useStored('ai-brain-conversation', 'dm:main');
  const [chatState, setChatState] = useStored('ai-brain-chat', 'open');
  const [newProject, setNewProject] = useState(false);
  const [draft, setDraft] = useState<string | undefined>();

  if (ws.error) return <main className="main"><div className="error">Can't reach the AI Brain daemon: {ws.error}</div></main>;
  if (!ws.data) return null;
  if (!ready) return <Onboarding onDone={() => { ws.reload(); profile.reload(); }} />;

  const list = projects.data ?? [];
  const conversations = convs.data ?? [];
  const current = conversations.find((c) => c.id === convId) ?? conversations.find((c) => c.id === 'dm:main') ?? null;
  const select = (id: string) => {
    setConvId(id);
    setChatState('open');
    convs.reload();
  };
  const askMain = (text: string) => {
    select('dm:main');
    if (text) setDraft(text);
  };

  let page: React.ReactNode;
  if (parts.length === 0) page = <Home projects={list} />;
  else if (parts[0] === 'project' && parts[1])
    page = <ProjectPage key={parts[1]} id={parts[1]} tab={parts[2] ?? ''} sub={parts[3] ?? null} roles={roles.data ?? []} openConversation={select} />;
  else if (parts[0] === 'personal') page = <Personal />;
  else if (parts[0] === 'settings') page = <Settings section={parts[1] ?? 'integrations'} roles={roles.data ?? []} />;
  else page = <div className="empty">Not found. <a href="/app/">Go home</a></div>;

  return (
    <div className="app">
      <Header theme={theme} toggleTheme={toggleTheme} name={profile.data?.name ?? ''} />
      <div className="body">
        <Sidebar
          key={list.length ? 'loaded' : 'empty'}
          projects={list}
          path={path}
          mainOn={current?.id === 'dm:main'}
          onMain={() => select('dm:main')}
          mainWorking={Boolean(conversations.find((c) => c.id === 'dm:main')?.working)}
          onNewProject={() => setNewProject(true)}
        >
          <TeamList conversations={conversations} roles={roles.data ?? []} current={current?.id ?? null} select={select} />
        </Sidebar>
        <main className="main">{page}</main>
        {chatState === 'open' ? (
          <ChatPanel conversation={current} roles={roles.data ?? []} onSent={convs.reload} onClose={() => setChatState('closed')} draftText={draft} onDraftUsed={() => setDraft(undefined)} />
        ) : (
          <RightRail roles={roles.data ?? []} conversations={conversations} open={select} onExpand={() => setChatState('open')} />
        )}
        {newProject && <NewProjectDialog onClose={() => setNewProject(false)} askMain={askMain} />}
      </div>
    </div>
  );
}
