-- Single source of truth for all table/index DDL. Applied by migrate() in db.ts;
-- do not re-declare CREATE TABLE for these tables anywhere else.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,           -- uuid
  name        TEXT NOT NULL,
  root_path   TEXT NOT NULL UNIQUE,       -- absolute cwd, for get_or_create
  parent_id   TEXT REFERENCES projects(id),  -- workspace this vertical belongs to, or null (top-level)
  autopilot   INTEGER NOT NULL DEFAULT 0, -- 1 = daemon nudges an idle session that has queued cards
  board_settings TEXT,                    -- JSON: per-board stuck thresholds + WIP limits, or null (defaults)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phases (
  id          TEXT PRIMARY KEY,           -- short id
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  goal        TEXT,                       -- markdown: what this phase delivers
  plan        TEXT,                       -- markdown: per-phase implementation plan (filled lazily)
  status      TEXT NOT NULL DEFAULT 'planned',   -- planned|active|done
  position    INTEGER NOT NULL DEFAULT 0,
  budget_usd  REAL,                       -- optional spend budget for the phase (USD), or null
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,        -- short id, also used as worktree name
  project_id     TEXT NOT NULL REFERENCES projects(id),
  phase_id       TEXT,                    -- the phase this card belongs to, or null (flat/legacy)
  title          TEXT NOT NULL,
  lane           TEXT NOT NULL DEFAULT 'backlog',   -- backlog|queued|in_progress|in_review|done
  requirements   TEXT,                    -- markdown, authored from discussion
  tag            TEXT,                    -- ui|api|db|infra
  skill          TEXT,                    -- assigned persona skill name (from the team roster)
  assigned_agent TEXT,                    -- current owner label
  worktree_path  TEXT,                    -- .trees/<id>  (also the agent<->card correlation key)
  branch         TEXT,                    -- card/<id>
  depends_on     TEXT,                    -- JSON array of task ids
  subtasks       TEXT,                    -- JSON array of {text,done} acceptance criteria
  blocked_at     INTEGER,                 -- epoch ms a builder raised a blocker, or null (not blocked)
  blocked_reason TEXT,                    -- the decision/question the blocker needs, or null
  work_type      TEXT CHECK (work_type IN ('feature','defect','debt','risk')),  -- null = unclassified
  estimate_hours REAL,                    -- rough hours a human engineer would take, or null (no estimate)
  review_rounds  INTEGER NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (  -- audit log + live ticker feed
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  task_id     TEXT,                       -- nullable for project-level events
  type        TEXT NOT NULL,              -- create|move|assign|note|tool|build_start|build_end|review
  payload     TEXT,                       -- JSON: {from,to} | {tool,file} | ...
  agent       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  round       INTEGER NOT NULL,
  verdict     TEXT NOT NULL,              -- pass|fail
  findings    TEXT,                       -- JSON: [{file,line,severity,note}]
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (  -- named agents + their assigned skill (persona)
  id          TEXT PRIMARY KEY,           -- agent id (short id)
  name        TEXT NOT NULL,
  skill       TEXT,                       -- assigned skill name (persona), or null
  color       TEXT,                       -- hex for the UI chip
  avatar      TEXT,                       -- uploaded image file name under <data dir>/avatars, or null
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS card_activity (  -- one row per build run: cost + churn + time
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  agent         TEXT,                      -- team member credited (card's assigned_agent), else the subagent type
  role          TEXT,                      -- subagent type that ran it (builder, reviewer, ...)
  agent_id      TEXT,                      -- subagent id
  tokens        INTEGER NOT NULL DEFAULT 0,   -- total billable tokens for the run
  tokens_out    INTEGER NOT NULL DEFAULT 0,   -- output tokens (subset of tokens)
  lines_added   INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  ms            INTEGER NOT NULL DEFAULT 0,   -- wall-clock of the build run
  estimated     INTEGER NOT NULL DEFAULT 0,   -- 1 = legacy line counts that couldn't be recomputed from git (excluded from line totals)
  usage         TEXT,                       -- JSON token breakdown keyed by model: {"<model>": {input, output, cache_read, cache_creation}}, or null
  cost_estimated INTEGER NOT NULL DEFAULT 0, -- 1 = no usage breakdown (legacy row / old hook): cost is estimated from `tokens` (see core/cost.ts)
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (  -- small global key/value settings (JSON values), e.g. 'prices'
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,              -- JSON
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (  -- durable event log for fan-out delivery (Phase 3 dispatcher drains it)
  id              INTEGER PRIMARY KEY AUTOINCREMENT,   -- monotonic cursor for the future dispatcher
  project_id      TEXT NOT NULL,
  task_id         TEXT,                       -- nullable, for task events
  type            TEXT NOT NULL,              -- EventType: create|move|assign|note|block|...
  payload         TEXT,                       -- JSON snapshot of event details
  created_at      INTEGER NOT NULL,           -- epoch ms
  status          TEXT DEFAULT 'pending',     -- FAN-OUT marker: pending (not yet fanned out) -> processed (delivery rows created). Per-target delivered/failed/dead lives in the deliveries table, not here.
  attempts        INTEGER DEFAULT 0,          -- Phase 3 dispatcher increments on retry
  last_attempt_at INTEGER,                    -- Phase 3 dispatcher updates; null until first delivery attempt
  origin          TEXT NOT NULL DEFAULT 'local'  -- loop-prevention tag: 'local' (originated here) vs a remote provider (Phase 5 bridge)
);

CREATE TABLE IF NOT EXISTS subscriptions (  -- registry of "who wants which events" (Phase 3 dispatcher reads it)
  id           TEXT PRIMARY KEY,           -- short id (same shortId convention as tasks/phases/team_members)
  project_id   TEXT,                       -- nullable: null = applies to all projects
  kind         TEXT NOT NULL CHECK (kind IN ('webhook','connector','bridge')),
  event_filter TEXT NOT NULL,              -- comma-separated EventType values (create|move|assign|...) or '*'
  target       TEXT NOT NULL,              -- where events are delivered (e.g. a URL for webhooks)
  secret       TEXT,                       -- nullable: signing/auth secret (stored here for now)
  scopes       TEXT,                       -- nullable: comma-separated scope tokens (consumed by the inbound API)
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL            -- epoch ms
);

CREATE TABLE IF NOT EXISTS deliveries (  -- per-(outbox event x subscription) delivery state machine + attempt log (Phase 3 dispatcher fans out into this)
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id        INTEGER NOT NULL,           -- the outbox event being delivered
  subscription_id  TEXT NOT NULL,              -- the target subscription
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending|delivered|failed|dead
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,                    -- nullable; HTTP status of last attempt
  last_error       TEXT,                       -- nullable
  next_attempt_at  INTEGER,                    -- nullable; when a retry is due (backoff scheduling)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (outbox_id, subscription_id)          -- makes fan-out idempotent: a re-run can't double-create a delivery row
);

CREATE TABLE IF NOT EXISTS sync_links (  -- local<->remote link state for the bridge (Phase 5 foundations; sync engine lands in later cards)
  id             TEXT PRIMARY KEY,           -- short id (same shortId convention as tasks/phases/subscriptions)
  project_id     TEXT,                       -- nullable
  local_id       TEXT NOT NULL,              -- the local card/task id
  provider       TEXT NOT NULL,              -- free text (e.g. 'jira'|'linear'); no provider code here
  external_id    TEXT,                       -- nullable: the remote item id, null until linked
  local_hash     TEXT,                       -- nullable: set by the sync engine later
  remote_hash    TEXT,                       -- nullable
  last_synced_at INTEGER,                    -- nullable
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (provider, local_id)                -- one link per (provider, local card)
);

CREATE TABLE IF NOT EXISTS plan_drafts (  -- visual-planner drafts: a workspace-wide plan kept off the board until committed
  id                TEXT PRIMARY KEY,         -- short id
  workspace_id      TEXT NOT NULL,            -- top-level project (a workspace or a standalone project), never a vertical
  title             TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,  -- bumped on every applied ops batch
  data              TEXT NOT NULL,            -- JSON PlanData: {nodes, edges, committed}
  committed_version INTEGER,                  -- version last committed to the boards, or null
  committed_at      INTEGER,                  -- epoch ms of the last commit, or null
  created_at        INTEGER,
  updated_at        INTEGER
);

CREATE TABLE IF NOT EXISTS wait_intervals (  -- time a session sat waiting on the human (persisted from the in-memory session state)
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  agent_id    TEXT,                       -- the waiting session's agent id, else its agent name (e.g. 'orchestrator')
  task_id     TEXT,                       -- the card the session was on, when known
  kind        TEXT NOT NULL,              -- 'needs_you'
  started_at  INTEGER NOT NULL,           -- epoch ms
  ended_at    INTEGER,                    -- epoch ms, null = still waiting
  reason      TEXT,                       -- the notification detail, when known
  closed_by   TEXT                        -- the state it left for (working|idle|offline), or 'restart'
);

CREATE TABLE IF NOT EXISTS decisions (  -- decision log: what was decided, why, by whom (workspace-level items use the workspace id)
  id            TEXT PRIMARY KEY,         -- short id
  project_id    TEXT NOT NULL,            -- the board it belongs to (a workspace, vertical or standalone project)
  title         TEXT NOT NULL,
  decision      TEXT NOT NULL,            -- markdown: what was decided
  rationale     TEXT,                     -- markdown: why, or null
  decided_by    TEXT,                     -- who made/confirmed it (e.g. 'user'), or null
  decided_at    INTEGER NOT NULL,         -- epoch ms
  status        TEXT NOT NULL DEFAULT 'active',  -- active|superseded
  superseded_by TEXT,                     -- the decision that replaced this one, or null
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS risks (  -- risk register: score = likelihood x impact
  id          TEXT PRIMARY KEY,           -- short id
  project_id  TEXT NOT NULL,              -- the board it belongs to (a workspace, vertical or standalone project)
  title       TEXT NOT NULL,
  description TEXT,
  likelihood  INTEGER NOT NULL,           -- 1-5
  impact      INTEGER NOT NULL,           -- 1-5
  owner       TEXT,
  mitigation  TEXT,
  status      TEXT NOT NULL DEFAULT 'open',  -- open|mitigating|closed|occurred
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  closed_at   INTEGER                     -- epoch ms it became closed|occurred, null while open|mitigating
);

-- One link table for both kinds: a single link/unlink/filter code path, and one cleanup statement
-- per project delete. kind + item_id name the decision/risk; target_* the card, phase or plan draft.
CREATE TABLE IF NOT EXISTS governance_links (
  kind        TEXT NOT NULL,              -- decision|risk
  item_id     TEXT NOT NULL,
  target_type TEXT NOT NULL,              -- card|phase|plan
  target_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (kind, item_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS milestones (  -- dated project milestones (workspace-level items use the workspace id)
  id          TEXT PRIMARY KEY,           -- short id
  project_id  TEXT NOT NULL,              -- the board it belongs to (a workspace, vertical or standalone project)
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,              -- YYYY-MM-DD
  phase_id    TEXT,                       -- optional phase it marks (same workspace), null when none/deleted
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_lane ON tasks(project_id, lane, position);
CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id, position);
CREATE INDEX IF NOT EXISTS idx_events_recent ON task_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_card_activity_project ON card_activity(project_id);
CREATE INDEX IF NOT EXISTS idx_card_activity_task ON card_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_task_type ON task_events(task_id, type, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_drafts_workspace ON plan_drafts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_wait_intervals_project ON wait_intervals(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id, date);
CREATE INDEX IF NOT EXISTS idx_governance_links_target ON governance_links(target_type, target_id);

CREATE TABLE IF NOT EXISTS phase_snapshots (  -- one row per phase per day: forecast + scope + spend, for trend/compare
  project_id      TEXT NOT NULL,
  phase_id        TEXT NOT NULL,
  date            TEXT NOT NULL,          -- YYYY-MM-DD the snapshot was taken
  target_date     TEXT,                   -- the phase's target that day (YYYY-MM-DD), or null
  p50             TEXT,                   -- forecast finish days (YYYY-MM-DD), or null (no forecast)
  p85             TEXT,
  p95             TEXT,
  scope           INTEGER,                -- cards in the phase
  done            INTEGER,                -- cards done
  budget_usd      REAL,                   -- the phase's budget that day, or null
  spend_usd       REAL,                   -- spend to date
  open_risk_score REAL,                   -- sum of open linked risk scores
  rag             TEXT,                   -- red|amber|green
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (phase_id, date)
);
CREATE INDEX IF NOT EXISTS idx_phase_snapshots_project ON phase_snapshots(project_id, date);

CREATE TABLE IF NOT EXISTS milestone_snapshots (  -- a milestone's date as it stood each day (slip tracking)
  milestone_id    TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  date            TEXT NOT NULL,          -- YYYY-MM-DD the snapshot was taken
  milestone_date  TEXT NOT NULL,          -- the milestone's date that day (YYYY-MM-DD)
  PRIMARY KEY (milestone_id, date)
);
CREATE INDEX IF NOT EXISTS idx_milestone_snapshots_project ON milestone_snapshots(project_id, date);

CREATE TABLE IF NOT EXISTS usage_samples (  -- persisted /usage pushes (the daemon's in-memory usageSamples)
  at    INTEGER PRIMARY KEY,              -- epoch ms of the push (UsageSample.at)
  data  TEXT NOT NULL                     -- JSON UsageSample: {at, five_hour, seven_day} (see core/usage-burn.ts)
);

CREATE TABLE IF NOT EXISTS dashboard_layouts (  -- a board's saved dashboard; absent = the builtin default
  project_id  TEXT PRIMARY KEY,
  layout      TEXT NOT NULL,              -- JSON DashboardLayout
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_templates (  -- user-saved layouts (builtin templates are code, not rows)
  id          TEXT PRIMARY KEY,           -- short id
  name        TEXT NOT NULL,
  layout      TEXT NOT NULL,              -- JSON DashboardLayout
  created_at  INTEGER NOT NULL
);
