#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit|NotebookEdit): warn a vertical-bound
// session (KANKAN_PROJECT_ID) when it edits outside its vertical's folder.
// The edit already happened — exit 2 only feeds the warning back to Claude.
// Best-effort: unbound, not a vertical, daemon down, bad input → exit 0.
import { isAbsolute, resolve } from 'node:path';
import { api, readStdin } from './lib.js';

const envId = process.env.KANKAN_PROJECT_ID;
if (!envId) process.exit(0);

const data = await readStdin();
const input = data.tool_input ?? {};
const raw = input.file_path ?? input.notebook_path;
if (typeof raw !== 'string' || !raw) process.exit(0);

const view = await api('GET', `/workspace?project=${encodeURIComponent(envId)}`);
const vertical = (view?.verticals ?? []).find((p) => p?.id === envId);
if (!vertical?.parent_id || !vertical.root_path) process.exit(0);

const abs = isAbsolute(raw) ? raw : resolve(String(data.cwd ?? process.cwd()), raw);
let target = abs;
// a kankan worktree path maps back to the repo path it mirrors
const m = target.match(/^(.*?)\/\.trees\/[^/]+\/(.*)$/);
if (m) target = `${m[1]}/${m[2]}`;

const root = vertical.root_path;
if (target === root || target.startsWith(`${root}/`)) process.exit(0);

process.stderr.write(
  `[kankan] scope: ${abs} is outside vertical "${vertical.name}" (${root}). ` +
    'If this is cross-cutting work it belongs on the workspace board — raise_blocker or leave a note instead of continuing.\n',
);
process.exit(2);
