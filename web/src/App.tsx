import { useApi } from './lib/api';
import { usePath } from './lib/router';
import { useTheme } from './lib/theme';
import type { ProjectSummary, WorkspaceInfo } from './lib/types';
import { Header, Sidebar } from './components/Shell';
import { Home } from './pages/Home';
import { Onboarding } from './pages/Onboarding';

const projectEvents = (m: any) => ['card', 'card_removed', 'phases', 'project_removed', 'workspace', 'brain_project'].includes(m?.type);

export function App() {
  const [theme, toggleTheme] = useTheme();
  const parts = usePath();
  const path = '/' + parts.join('/');
  const ws = useApi<WorkspaceInfo>('/api/workspace', (m) => m?.type === 'workspace');
  const profile = useApi<{ name: string | null }>('/api/profile', (m) => m?.type === 'profile');
  const projects = useApi<ProjectSummary[]>(ws.data?.configured ? '/api/projects' : null, projectEvents);

  if (ws.error) return <main className="main"><div className="error">Can't reach the AI Brain daemon: {ws.error}</div></main>;
  if (!ws.data) return null;
  if (!ws.data.configured) return <Onboarding onDone={() => { ws.reload(); profile.reload(); }} />;

  const list = projects.data ?? [];
  let page: React.ReactNode;
  if (parts.length === 0) page = <Home projects={list} />;
  else page = <div className="empty">This screen is being built.</div>;

  return (
    <div className="app">
      <Header theme={theme} toggleTheme={toggleTheme} name={profile.data?.name ?? ''} />
      <div className="body">
        <Sidebar key={list.length ? 'loaded' : 'empty'} projects={list} path={path} />
        <main className="main">{page}</main>
      </div>
    </div>
  );
}
