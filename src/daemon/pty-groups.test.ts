import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ptyGroups } from './pty-groups.js';

const OWN = 500;

test("ptyGroups: no controlling tty ('??', '-', '') → the shell's group only", () => {
  const everything = '  1 ??\n 77 ??\n 88 ttys003\n';
  for (const tty of ['??', '-', '', '  ??  ']) assert.deepEqual(ptyGroups(100, tty, everything, OWN), [100]);
});

test('ptyGroups: macOS ttys003 and Linux pts/4 accepted', () => {
  assert.deepEqual(ptyGroups(100, 'ttys003\n', '100 ttys003\n101 ttys003\n', OWN), [100, 101]);
  assert.deepEqual(ptyGroups(100, 'pts/4', '  100 pts/4\n  102 pts/4\n', OWN), [100, 102]);
});

test("ptyGroups: the daemon's own group and groups 0/1 are never included", () => {
  const out = `0 ttys003\n1 ttys003\n${OWN} ttys003\n101 ttys003\n`;
  assert.deepEqual(ptyGroups(100, 'ttys003', out, OWN), [100, 101]);
  assert.deepEqual(ptyGroups(OWN, 'ttys003', '', OWN), []);
  assert.deepEqual(ptyGroups(1, '??', '', OWN), []);
});

test('ptyGroups: rows on another tty (ps quirks) are filtered out', () => {
  const out = '100 ttys003\n101 ttys003\n202 ttys004\n303 ??\n404\n';
  assert.deepEqual(ptyGroups(100, 'ttys003', out, OWN), [100, 101]);
});
