export type Stage = 'idea' | 'create' | 'requirements' | 'design' | 'plan' | 'build';
export const STAGES: Stage[] = ['idea', 'create', 'requirements', 'design', 'plan', 'build'];
export const STAGE_LABEL: Record<Stage, string> = { idea: 'Idea', create: 'Create', requirements: 'Reqs', design: 'Design', plan: 'Plan', build: 'Build' };

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  stage: Stage;
  description: string | null;
  verticals: { id: string; name: string; done: number; total: number }[];
  phase: { index: number; count: number; title: string } | null;
  cards: { done: number; total: number };
  liveAgents: number;
  blocked: number;
  inReview: number;
}

export interface WorkspaceInfo {
  configured: boolean;
  root: string | null;
  db: string;
}
