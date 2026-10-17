#!/usr/bin/env node
// JSON merge helper for init-project.sh. Never removes or overwrites
// anything the user already has; only adds what's missing. Idempotent.
//
//   node merge-config.js settings <ours.json> <theirs.json>
//   node merge-config.js mcp <theirs.json> <server.js path> <daemon url>
//
// Prints one word: installed | merged | unchanged
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);

const load = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const save = (p, obj) => writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);

if (mode === 'settings') {
  const [oursPath, theirsPath] = args;
  const ours = JSON.parse(readFileSync(oursPath, 'utf8'));
  if (!existsSync(theirsPath)) {
    save(theirsPath, ours);
    console.log('installed');
    process.exit(0);
  }
  const theirs = load(theirsPath, {});
  let changed = false;

  // statusline: only if they don't have one — theirs wins
  if (!theirs.statusLine && ours.statusLine) {
    theirs.statusLine = ours.statusLine;
    changed = true;
  }

  // hooks: append our entries per event, matched by hook command strings
  theirs.hooks ??= {};
  for (const [event, entries] of Object.entries(ours.hooks ?? {})) {
    theirs.hooks[event] ??= [];
    const present = new Set(
      theirs.hooks[event].flatMap((e) => (e.hooks ?? []).map((h) => h.command)),
    );
    for (const entry of entries) {
      if ((entry.hooks ?? []).every((h) => present.has(h.command))) continue; // already wired
      theirs.hooks[event].push(entry);
      changed = true;
    }
  }

  // a server approved under its old name stays approved under the new one
  const enabled = theirs.enabledMcpjsonServers;
  if (Array.isArray(enabled) && enabled.includes('kankan')) {
    theirs.enabledMcpjsonServers = [...new Set(enabled.map((n) => (n === 'kankan' ? 'kanban' : n)))];
    changed = true;
  }

  // permissions.allow: union our rules in (deduped); theirs are preserved
  for (const rule of ours.permissions?.allow ?? []) {
    theirs.permissions ??= {};
    theirs.permissions.allow ??= [];
    if (!theirs.permissions.allow.includes(rule)) {
      theirs.permissions.allow.push(rule);
      changed = true;
    }
  }

  if (changed) save(theirsPath, theirs);
  console.log(changed ? 'merged' : 'unchanged');
} else if (mode === 'mcp') {
  const [theirsPath, serverJs, daemonUrl] = args;
  const existed = existsSync(theirsPath);
  const theirs = load(theirsPath, {});
  theirs.mcpServers ??= {};
  // older installs named the board server kankan: rename it
  const legacy = Boolean(theirs.mcpServers.kankan);
  delete theirs.mcpServers.kankan;
  if (theirs.mcpServers.kanban && !legacy) {
    console.log('unchanged');
  } else {
    theirs.mcpServers.kanban = { command: 'node', args: [serverJs], env: { DAEMON_URL: daemonUrl } };
    save(theirsPath, theirs);
    console.log(existed ? 'merged' : 'installed');
  }
} else {
  console.error('usage: merge-config.js settings|mcp ...');
  process.exit(1);
}
