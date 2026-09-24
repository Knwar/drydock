import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ptyGroups, shellInfo, stillOurs, ttyGroups } from './pty-groups.js';

const OWN = 500; // the daemon's own pgid
const DAEMON = 400; // the daemon's pid

test('shellInfo: ppid must be the daemon and the shell its own group leader', () => {
  assert.deepEqual(shellInfo(100, `  ${DAEMON}   100 ttys003\n`, DAEMON), { tty: 'ttys003' });
  assert.deepEqual(shellInfo(100, `${DAEMON} 100 pts/4`, DAEMON), { tty: 'pts/4' });
  assert.equal(shellInfo(100, '1 100 ttys003', DAEMON), null); // reused pid, someone else's child
  assert.equal(shellInfo(100, `${DAEMON} 99 ttys003`, DAEMON), null); // not a group leader
  assert.equal(shellInfo(100, '', DAEMON), null); // gone
});

test('ptyGroups: ppid mismatch → nothing at all; match → shell + tty groups', () => {
  const onTty = ttyGroups('ttys003', '100 ttys003\n101 ttys003\n', OWN);
  assert.deepEqual(ptyGroups(100, shellInfo(100, `1 100 ttys003`, DAEMON), onTty, OWN), []);
  assert.deepEqual(ptyGroups(100, shellInfo(100, `${DAEMON} 100 ttys003`, DAEMON), onTty, OWN), [100, 101]);
});

test("no usable tty ('??', '-', '') → the shell's group only", () => {
  const everything = '  1 ??\n 77 ??\n 88 ttys003\n';
  for (const tty of ['??', '-', '']) {
    const info = shellInfo(100, `${DAEMON} 100 ${tty}`, DAEMON);
    assert.deepEqual(info, { tty: null });
    assert.deepEqual(ptyGroups(100, info, [77, 88], OWN), [100]);
  }
  assert.deepEqual(ttyGroups('??', everything, OWN), []);
});

test("the daemon's own group and groups 0/1 are never included", () => {
  const out = `0 ttys003\n1 ttys003\n${OWN} ttys003\n101 ttys003\n`;
  assert.deepEqual(ttyGroups('ttys003', out, OWN), [101]);
  assert.deepEqual(ptyGroups(100, { tty: 'ttys003' }, [0, 1, OWN, 101], OWN), [100, 101]);
  assert.deepEqual(ptyGroups(OWN, { tty: null }, [], OWN), []);
  assert.deepEqual(ptyGroups(1, { tty: null }, [], OWN), []);
});

test('rows on another tty (ps quirks) are filtered out', () => {
  const out = '100 ttys003\n101 ttys003\n202 ttys004\n303 ??\n404\n';
  assert.deepEqual(ttyGroups('ttys003', out, OWN), [100, 101]);
});

test('stillOurs: SIGKILL only groups in both the original set and the re-enumeration', () => {
  assert.deepEqual(stillOurs([100, 101, 102], [101, 102, 999]), [101, 102]);
  assert.deepEqual(stillOurs([100], []), []);
});
