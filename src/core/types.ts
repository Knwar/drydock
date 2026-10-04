export const LANES = ['backlog', 'queued', 'in_progress', 'in_review', 'done'] as const;
export type Lane = (typeof LANES)[number];

export interface Project {
  id: string;
  name: string;
  root_path: string;
  parent_id: string | null; // workspace this vertical belongs to, or null (top-level)
  autopilot: number; // 1 = daemon nudges an idle session that has queued cards (default 0)
  board_settings: string | null; // JSON BoardSettings, or null (defaults) — read via getBoardSettings
  created_at: number;
}

/** A top-level project and its child verticals (empty for a standalone project). */
export interface WorkspaceView {
  workspace: Project;
  verticals: Project[];
}

export const PHASE_STATUSES = ['planned', 'active', 'done'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export interface Phase {
  id: string;
  project_id: string;
  title: string;
  goal: string | null; // markdown: what this phase delivers
  plan: string | null; // markdown: per-phase implementation plan (filled lazily)
  status: PhaseStatus; // planned → active → done
  position: number;
  budget_usd: number | null; // optional spend budget (USD), or null
  target_date: string | null; // optional target finish day (YYYY-MM-DD), or null
  created_at: number;
  updated_at: number;
}

/** Phase as the drawer/orchestrator read it: metadata + card progress. */
export interface PhaseView {
  id: string;
  title: string;
  goal: string | null;
  status: PhaseStatus;
  position: number;
  /** USD; null = no budget. */
  budget_usd: number | null;
  /** YYYY-MM-DD; null = no target. */
  target_date: string | null;
  progress: { done: number; total: number };
}

/** Token counts for one model (one build run, or summed). */
export interface ModelUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

/** A build run's token breakdown keyed by model id (card_activity.usage). */
export type UsageBreakdown = Record<string, ModelUsage>;

/** What kind of work a card is (tasks.work_type). null on a card = unclassified. */
export const WORK_TYPES = ['feature', 'defect', 'debt', 'risk'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export interface Task {
  id: string;
  project_id: string;
  phase_id: string | null; // the phase this card belongs to, or null (flat/legacy)
  title: string;
  lane: Lane;
  requirements: string | null;
  tag: string | null;
  skill: string | null; // assigned persona skill (from the team roster)
  assigned_agent: string | null;
  worktree_path: string | null;
  branch: string | null;
  depends_on: string | null; // JSON array of task ids
  subtasks: string | null; // JSON array of Subtask (acceptance criteria)
  blocked_at: number | null; // epoch ms a builder raised a blocker, or null (not blocked)
  blocked_reason: string | null; // the decision/question the blocker needs
  work_type: WorkType | null; // what kind of work this is, or null (unclassified)
  review_rounds: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface Subtask {
  text: string;
  done: boolean;
}

/** Terse card shape returned by board reads (keep token cost low). */
export interface CardSummary {
  id: string;
  title: string;
  lane: Lane;
  tag: string | null;
  skill: string | null;
  agent: string | null;
  rounds: number;
  updated_at: number;
  phase_id: string | null;
  blocked: boolean; // a builder raised a blocker on this card
  blocked_reason: string | null; // the decision/question it needs
  subs: { done: number; total: number } | null;
  lane_since: number | null; // epoch ms an in-flight card entered its lane (last move into it, else creation); null otherwise
}

/** A board's dashboard: sections of rows of slots of widgets (dashboard_layouts.layout). */
export interface DashboardLayout {
  version: 1;
  sections: DashSection[];
}

export interface DashSection {
  id: string;
  title: string;
  collapsed?: boolean;
  rows: DashRow[];
}

export interface DashRow {
  id: string;
  height: number; // integer row units 1-12 (1 unit = 88px, rendered by the UI)
  slots: DashSlot[];
}

/** A column in a row; spans in a row sum to <= 12, and its widgets stack vertically. */
export interface DashSlot {
  id: string;
  span: number; // integer 1-12
  widgets: DashWidget[];
}

/** A tab group is a widget of type 'tabs' with params { tabs: [{ id, title, rows }] } (never nested). */
export interface DashWidget {
  id: string;
  type: string;
  size: 'S' | 'M' | 'L' | 'XL';
  params: Record<string, unknown>;
}

/** Per-board work-in-progress health config (projects.board_settings). */
export interface BoardSettings {
  stuck_hours: { queued: number; in_progress: number; in_review: number }; // a card longer than this in the lane is "stuck"
  wip: { in_progress: number | null; in_review: number | null }; // optional lane limits (null = none); warn only
}

/** The canonical set of event types, the single source of truth for the union
 *  below and for runtime validation (e.g. subscription event_filter tokens). */
export const EVENT_TYPES = [
  'create',
  'move',
  'assign',
  'note',
  'tool',
  'build_start',
  'build_end',
  'review',
  'subtasks',
  'check',
  'delete',
  'redirect',
  'block',
  'unblock',
  'phase_create',
  'phase_activate',
  'phase_done',
  'phase_park',
  'vertical_create',
  'vertical_split',
  'vertical_merge',
  'autopilot',
  'phase_change',
  'reassign',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface TaskEvent {
  id: number;
  project_id: string;
  task_id: string | null;
  type: EventType;
  payload: string | null; // JSON
  agent: string | null;
  created_at: number;
}

export type Verdict = 'pass' | 'fail';

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: string;
  note: string;
}

export interface TeamMember {
  id: string; // agent id
  name: string;
  skill: string | null; // assigned skill name (persona)
  color: string | null;
  avatar: string | null; // uploaded image file name (served at /avatars/<name>), or null
  created_at: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: string; // user | project
}

export interface CardTotals {
  tokens: number;
  tokens_out: number;
  lines_added: number;
  lines_removed: number;
  ms: number;
}

export interface AgentStat extends CardTotals {
  agent: string;
  cards: number;
}

export interface ProjectStats {
  totals: CardTotals & { cards: number };
  agents: AgentStat[];
}

export type AttentionKind =
  | 'blocked'
  | 'review_failed'
  | 'merge_conflict'
  | 'stalled'
  | 'awaiting_review'
  | 'needs_spec'
  | 'sync_conflict';
export type AttentionSeverity = 'blocker' | 'warn' | 'info';

export const SUBSCRIPTION_KINDS = ['webhook', 'connector', 'bridge'] as const;
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];

/** Full internal subscription row — includes the raw secret. Never returned
 *  over any HTTP/MCP API; use SubscriptionView for public reads. */
export interface Subscription {
  id: string;
  project_id: string | null; // null = applies to all projects
  kind: SubscriptionKind;
  event_filter: string; // '*' or comma-separated EventType list
  target: string; // delivery target (e.g. a webhook URL)
  secret: string | null; // signing/auth secret — redacted in the view
  scopes: string | null; // comma-separated scope tokens (enforced in a later phase)
  enabled: number; // 0 | 1
  created_at: number;
}

/** One delivery attempt-state row: an outbox event fanned out to a subscription.
 *  Pure read shape for the observability listing (deliveries table row). */
export interface Delivery {
  id: number;
  outbox_id: number;
  subscription_id: string;
  status: string; // pending|delivered|failed|dead
  attempts: number;
  last_status_code: number | null; // HTTP status of last attempt
  last_error: string | null;
  next_attempt_at: number | null; // when a retry is due (backoff)
  created_at: number;
  updated_at: number;
}

/** One local<->remote link row for the bridge (Phase 5 foundations). Tracks
 *  which local card maps to which remote item per provider, plus the sync
 *  bookkeeping (hashes + last_synced_at) the sync engine fills in later. */
export interface SyncLink {
  id: string;
  project_id: string | null;
  local_id: string; // the local card/task id
  provider: string; // free text (e.g. 'jira'|'linear')
  external_id: string | null; // the remote item id, null until linked
  local_hash: string | null; // set by the sync engine later
  remote_hash: string | null;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Public/redacted subscription — every field EXCEPT the raw secret, which is
 *  collapsed to has_secret. This is the ONLY shape board.ts hands to callers. */
export interface SubscriptionView {
  id: string;
  project_id: string | null;
  kind: SubscriptionKind;
  event_filter: string;
  target: string;
  has_secret: boolean; // whether a secret is set (the value itself is never exposed)
  scopes: string | null;
  enabled: number;
  created_at: number;
}

/** One card that needs a human decision, for the overlay's Attention queue. */
export interface AttentionItem {
  card_id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  reason: string; // human sentence for the row
  since: number; // epoch ms it entered this state → "23m in state"
  blocking: number; // # open cards whose depends_on includes this card
  agent: string | null;
  phase_id: string | null;
}

/** One board (workspace or vertical) in a workspace summary. */
export interface BoardSummary {
  project: { id: string; name: string; root_path: string; parent_id: string | null; autopilot: number };
  lanes: Record<Lane, number>;
  active: { id: string; title: string; lane: Lane; agent: string | null; blocked: boolean; lane_since: number }[];
  blocked: number; // open cards with a raised blocker
  settings: BoardSettings; // stuck thresholds + WIP limits
  phase: { id: string; title: string; done: number; total: number } | null; // the active phase (or the filter's)
  totals: CardTotals & { cards: number };
  shown: boolean; // the filters leave this board on the dashboard (scope; a phase → its board)
}

/** Dashboard / Home filters. scope: a board id (none or the workspace id → every board);
 *  from / to (epoch ms, inclusive) bound when a done card entered done. */
export interface CardFilter {
  scope?: string | null;
  phase?: string | null;
  tag?: string | null;
  agent?: string | null;
  from?: number | null;
  to?: number | null;
  /** A work type, or 'none' for unclassified cards (work_type IS NULL). */
  workType?: WorkType | 'none';
}

/** One phase's state on one day (phase_snapshots row). Dates are YYYY-MM-DD. */
export interface PhaseSnapshot {
  project_id: string;
  phase_id: string;
  date: string;
  target_date: string | null;
  p50: string | null; // forecast finish days, null = no forecast
  p85: string | null;
  p95: string | null;
  scope: number | null; // cards in the phase
  done: number | null; // cards done
  budget_usd: number | null;
  spend_usd: number | null;
  open_risk_score: number | null;
  rag: string | null; // red|amber|green
  created_at: number;
}

/** A milestone's date as it stood on one day (milestone_snapshots row). Dates are YYYY-MM-DD. */
export interface MilestoneSnapshot {
  milestone_id: string;
  project_id: string;
  date: string;
  milestone_date: string;
}

/** A from/to range (epoch ms, inclusive). */
export interface TimeWindow {
  from: number;
  to: number;
}

/** Period-over-period compare, carried alongside a current result T: the same result over
 *  the preceding window of equal length. previous is null when there is nothing to compare. */
export interface Compare<T> {
  previous: T | null;
  window: TimeWindow;
  previousWindow: TimeWindow;
}

/** One agent's headline numbers over a period. */
export interface AgentHistoryTotals {
  cardsDone: number;
  firstPassRate: number | null; // share of reviewed cards that passed round 1, null = none reviewed
  medianCycleMs: number | null; // null = no done cards
  cost: number; // USD
  tokens: number;
  blockers: number;
  hours: number;
}

/** One card an agent worked on. */
export interface AgentHistoryCard {
  id: string;
  title: string;
  project_id: string;
  started_at: number | null; // epoch ms
  done_at: number | null; // epoch ms, null = not done
  outcome: string; // e.g. done | in_review | in_progress | abandoned
  rounds: number;
  blockers: number;
  cost: number; // USD
  tokens: number;
  lines_added: number;
  lines_removed: number;
}

/** One build run credited to the agent (a card_activity row). */
export interface AgentHistoryRun {
  task_id: string;
  role: string | null;
  at: number; // epoch ms
  ms: number;
  tokens: number;
  cost: number; // USD
}

/** An agent's track record: the cards and runs, period totals, and a weekly series of the same totals. */
export interface AgentHistory {
  agent: string;
  cards: AgentHistoryCard[];
  runs: AgentHistoryRun[];
  totals: AgentHistoryTotals;
  weekly: (AgentHistoryTotals & { week: string })[]; // week = YYYY-MM-DD of its first day
}

/** One card on GET /workspace/cards. lane_since: when it entered its lane (backlog: its last update). */
export interface WorkspaceCard {
  id: string;
  title: string;
  board: string;
  lane: Lane;
  phase_id: string | null;
  tag: string | null;
  agent: string | null;
  lane_since: number;
  blocked: boolean;
}

/** GET /workspace/cards: the cards matching the filters, plus the filter options (the whole workspace's). */
export interface WorkspaceCards {
  workspace_id: string;
  boards: BoardRef[];
  phases: { id: string; title: string; status: PhaseStatus; board: string }[];
  tags: string[];
  agents: string[];
  cards: WorkspaceCard[];
}

/** An attention item tagged with the board it came from. */
export interface WorkspaceAttentionItem extends AttentionItem {
  project_id: string;
  project_name: string;
}

/** Cross-board status for a whole workspace: the workspace first, then its verticals. */
export interface WorkspaceSummary {
  workspace: { id: string; name: string };
  boards: BoardSummary[];
  attention: WorkspaceAttentionItem[];
}

/** A board reference on Home-view items. */
export interface BoardRef {
  id: string;
  name: string;
}

/** An unfinished (or unknown) dependency a card is waiting on. */
export interface WaitingOn {
  id: string;
  title: string | null; // null = unknown card id
  board_name: string | null; // null = unknown card id
}

/** One card in the Home view's "up next" list. */
export interface UpNextItem {
  id: string;
  title: string;
  lane: Lane;
  tag: string | null;
  board: BoardRef;
  ready: boolean; // no waiting_on
  waiting_on: WaitingOn[];
}

export interface UpNext {
  items: UpNextItem[];
  total_pending: number; // queued + pickable backlog in scope
  pending: { id: string; board: BoardRef }[]; // the first 200 total_pending cards, in pick order (Up next's "View all" highlight)
}

/** One in_progress / in_review card in the Home view's "now building" list. */
export interface NowBuildingItem {
  id: string;
  title: string;
  lane: Lane;
  board: BoardRef;
  agent: string | null;
  subtasks: { done: number; total: number };
  next_criterion: string | null; // first unchecked subtask text
  since: number; // epoch ms the card entered its current lane
  blocked: boolean;
}

/** A team member with their activity on a project (or workspace). */
export interface AgentBoardEntry {
  id: string;
  name: string;
  skill: string | null;
  color: string | null;
  avatar: string | null;
  lines_added: number;
  lines_removed: number;
  hours: number; // build time, 1 decimal
  cards: number;
}

/** A folder a card could be placed under (Split dialog). folder is repo-relative, '' = repo root. */
export interface PlacementTarget {
  key: string;
  folder: string;
}

/** Where an open card most likely belongs, judged from the files it edited. */
export interface CardPlacement {
  card: { id: string; title: string; lane: Lane };
  suggestion: string | null; // a PlacementTarget.key
  confidence: 'strong' | 'mixed' | 'none';
  evidence: string;
  files: number; // distinct edited file paths counted
}

// ── visual planner drafts (plans kept off the board until committed) ──

export const PLAN_TAGS = ['ui', 'api', 'db', 'infra'] as const;
export type PlanTag = (typeof PLAN_TAGS)[number];

/** One planned card. `id` is client-generated and unique within its draft. */
export interface PlanNode {
  id: string;
  title: string;
  requirements?: string;
  subtasks?: string[];
  tag?: PlanTag;
  board_id: string; // the workspace itself or one of its verticals
  phase?: string; // a phase NAME
  touches?: string[]; // repo-relative paths/globs the card is expected to change
}

/** `to` depends on `from`. */
export interface PlanEdge {
  from: string;
  to: string;
}

/** The JSON stored in plan_drafts.data. */
export interface PlanData {
  nodes: PlanNode[];
  edges: PlanEdge[];
  committed: Record<string, string>; // nodeId -> cardId, maintained by commit
}

export interface PlanDraft {
  id: string;
  workspace_id: string;
  title: string;
  version: number;
  data: PlanData;
  committed_version: number | null;
  committed_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A draft without its heavy data, for lists. */
export interface PlanDraftSummary extends Omit<PlanDraft, 'data'> {
  node_count: number;
  edge_count: number;
}

export interface PlanIssue {
  code: string;
  message: string;
  nodes?: string[];
  edges?: PlanEdge[];
}

export interface PlanValidation {
  errors: PlanIssue[]; // block commit
  warnings: PlanIssue[]; // incl. one `shared_file` per pair of cards (full detail)
  /** The `shared_file` warnings grouped per path (code `shared_file_group`): one issue
   *  per touched path, listing every card involved. What the planner strip shows. */
  groups: PlanIssue[];
}

/** A board a node can target. root is relative to the workspace root ('' for the workspace). */
export interface PlanBoard {
  id: string;
  name: string;
  root: string;
}

export interface PlanContext {
  boards: PlanBoard[];
}

/** One edit to a draft; applied in batches by applyDraftOps. */
export type DraftOp =
  | { op: 'add_node'; node: PlanNode }
  | { op: 'update_node'; id: string; patch: Partial<Omit<PlanNode, 'id'>> }
  | { op: 'remove_node'; id: string }
  | { op: 'add_edge'; from: string; to: string }
  | { op: 'remove_edge'; from: string; to: string }
  | { op: 'set_title'; title: string };
