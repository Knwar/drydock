import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// End-to-end coverage for agent profiles: avatar upload/serve/delete and
// renames that carry an agent's history over.

// A tiny (1x1) valid PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('daemon team profiles', () => {
  let daemon: TestDaemon;
  let base: string;
  const avatarDir = () => join(daemon.dbDir, 'avatars');
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const upload = (id: string, type: string, bytes: Buffer) =>
    fetch(`${base}/team/${id}/avatar`, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(bytes) });
  const createMember = async (name: string) => {
    const res = await send('POST', '/team', { name });
    assert.equal(res.status, 200);
    return (await res.json()) as { id: string; name: string; avatar: string | null };
  };

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
  });

  after(async () => {
    await daemon?.stop();
  });

  it('uploads a PNG, serves identical bytes, replaces and deletes the file', async () => {
    const ada = await createMember('Ada');
    assert.equal(ada.avatar, null);
    const res = await upload(ada.id, 'image/png', PNG);
    assert.equal(res.status, 200);
    const member = (await res.json()) as { avatar: string };
    assert.match(member.avatar, new RegExp(`^${ada.id}-[0-9a-f]+\\.png$`));

    const img = await fetch(`${base}/avatars/${member.avatar}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('cache-control'), 'no-cache');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(PNG));

    // re-upload replaces: the previous file is gone
    const again = (await (await upload(ada.id, 'image/png', PNG)).json()) as { avatar: string };
    assert.notEqual(again.avatar, member.avatar);
    assert.deepEqual(readdirSync(avatarDir()), [again.avatar]);

    const del = await send('DELETE', `/team/${ada.id}/avatar`);
    assert.equal(del.status, 200);
    assert.equal(((await del.json()) as { avatar: string | null }).avatar, null);
    assert.equal(existsSync(join(avatarDir(), again.avatar)), false);
    assert.equal((await fetch(`${base}/avatars/${again.avatar}`)).status, 404);
  });

  it('rejects mismatched magic bytes (400), unsupported types (400) and > 2 MB (413)', async () => {
    const m = await createMember('Bad');
    assert.equal((await upload(m.id, 'image/png', JPEG_HEAD)).status, 400);
    assert.equal((await upload(m.id, 'image/gif', PNG)).status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    assert.equal((await upload(m.id, 'image/png', big)).status, 413);
    assert.equal((await upload('nope', 'image/png', PNG)).status, 404);
    const list = (await (await send('GET', '/team')).json()) as { id: string; avatar: string | null }[];
    assert.equal(list.find((x) => x.id === m.id)!.avatar, null);
  });

  it('GET /avatars rejects traversal and bad names with 404', async () => {
    for (const p of ['/avatars/..%2Fboard.db', '/avatars/..%2Fx', '/avatars/x.exe', '/avatars/x.png.exe', '/avatars/missing.png']) {
      assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    }
  });

  it('deleting a member removes its avatar file', async () => {
    const m = await createMember('Temp');
    const { avatar } = (await (await upload(m.id, 'image/png', PNG)).json()) as { avatar: string };
    assert.ok(existsSync(join(avatarDir(), avatar)));
    assert.equal((await send('DELETE', `/team/${m.id}`)).status, 200);
    assert.equal(existsSync(join(avatarDir(), avatar)), false);
  });

  it('PATCH rename carries stats history over; duplicate/empty names → 400', async () => {
    const root = join(daemon.dbDir, 'proj');
    mkdirSync(root, { recursive: true });
    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string }).project_id;
    const turing = await createMember('Turing');
    await createMember('Hopper');
    const task = ((await (await send('POST', '/task', { project_id: project, title: 'card' })).json()) as { task_id: string }).task_id;
    assert.equal((await send('POST', `/task/${task}/activity`, { agent: 'Turing', tokens: 123 })).status, 200);

    const dup = await send('PATCH', `/team/${turing.id}`, { name: 'Hopper' });
    assert.equal(dup.status, 400);
    assert.match(((await dup.json()) as { error: string }).error, /already exists/);
    assert.equal((await send('PATCH', `/team/${turing.id}`, { name: '  ' })).status, 400);
    assert.equal((await send('PATCH', '/team/nope', { name: 'X' })).status, 404);
    // a label that exists only in history (an ex-member) can't be taken over
    assert.equal((await send('POST', `/task/${task}/activity`, { agent: 'Ghost', tokens: 1 })).status, 200);
    const hist = await send('PATCH', `/team/${turing.id}`, { name: 'Ghost' });
    assert.equal(hist.status, 400);
    assert.match(((await hist.json()) as { error: string }).error, /already used in this board's history/);

    const ren = await send('PATCH', `/team/${turing.id}`, { name: 'Alan' });
    assert.equal(ren.status, 200);
    assert.equal(((await ren.json()) as { name: string }).name, 'Alan');
    const stats = (await (await fetch(`${base}/stats?project=${project}`)).json()) as { agents: { agent: string; tokens: number }[] };
    assert.deepEqual(stats.agents.map((a) => [a.agent, a.tokens]), [['Alan', 123], ['Ghost', 1]]);
  });
});
