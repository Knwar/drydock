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

export interface Role {
  id: string;
  name: string;
  initials: string;
  scope: 'global' | 'shared' | 'project';
  persona: string;
  skill: string | null;
  model: string;
  tone: string;
  builtin: number;
}

export interface Conversation {
  id: string;
  kind: 'dm' | 'channel';
  role_id: string | null;
  project_id: string | null;
  name: string;
  members: string[];
  last: { body: string; kind: string; author: string } | null;
  unread: number;
  working: string | null;
}

export interface Message {
  id: number;
  conversation_id: string;
  author: string;
  kind: 'text' | 'tool' | 'decision' | 'approval' | 'error';
  body: string;
  meta: any;
  created_at: number;
}
