#!/usr/bin/env node
// node-pty's macOS prebuilds ship spawn-helper without the exec bit, so every
// pty spawn fails with "posix_spawnp failed" after a fresh install.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

let root;
try {
  root = join(createRequire(import.meta.url).resolve('node-pty/package.json'), '..');
} catch {
  process.exit(0); // optional dependency not installed
}
const prebuilds = join(root, 'prebuilds');
if (!existsSync(prebuilds)) process.exit(0);
for (const dir of readdirSync(prebuilds)) {
  const helper = join(prebuilds, dir, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
