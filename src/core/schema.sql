-- Single source of truth for all table/index DDL. Applied by migrate() in db.ts;
-- do not re-declare CREATE TABLE for these tables anywhere else.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,           -- uuid
  name        TEXT NOT NULL,
  root_path   TEXT NOT NULL UNIQUE,       -- absolute cwd, for get_or_create
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
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS card_activity (  -- one row per build run: cost + churn + time
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  agent         TEXT,                      -- label / persona name
  agent_id      TEXT,                      -- subagent id
  tokens        INTEGER NOT NULL DEFAULT 0,   -- total billable tokens for the run
  tokens_out    INTEGER NOT NULL DEFAULT 0,   -- output tokens (subset of tokens)
  lines_added   INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  ms            INTEGER NOT NULL DEFAULT 0,   -- wall-clock of the build run
  created_at    INTEGER NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_tasks_project_lane ON tasks(project_id, lane, position);
CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id, position);
CREATE INDEX IF NOT EXISTS idx_events_recent ON task_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at);
