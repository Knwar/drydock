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
  containers: { id: string; name: string; components: number }[];
  phase: { index: number; count: number; title: string } | null;
  cards: { done: number; total: number };
  liveAgents: number;
  blocked: number;
  inReview: number;
  status: string;
  rag: string | null;
  type?: 'software' | 'general';
  plugins?: string[];
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
  effort?: string | null;
  default_effort?: string | null;
  /** how the role works inside Drydock: built in, read-only */
  contract?: string;
  /** library skill ids it loads (its own choice or the defaults) */
  skill_list?: string[];
  default_skills?: string[];
}

export interface Conversation {
  id: string;
  kind: 'dm' | 'channel';
  role_id: string | null;
  project_id: string | null;
  /** set on an idea's shaping chat */
  idea_id?: string | null;
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
  kind: 'text' | 'tool' | 'decision' | 'approval' | 'proposal' | 'secret_request' | 'change_request' | 'offer' | 'error';
  body: string;
  meta: any;
  created_at: number;
}

export interface IdeaCard {
  id: string;
  slug: string;
  title: string;
  pitch: string;
  type: 'software' | 'general';
  status: 'raw' | 'shaping' | 'parked' | 'promoted' | 'added';
  conversation_id: string | null;
  brand_id: string | null;
  project_id: string | null;
  /** set on a feature idea: the project it would change */
  parent_project_id: string | null;
  updated_at: number;
  requirementsVersion: number | null;
  designElements: number;
  brand: { id: string; name: string } | null;
  screens: number;
  features?: number;
  mvpFeatures?: number;
  missing: string[];
  working: boolean;
}
