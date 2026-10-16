#!/usr/bin/env node
// Stand-in for the Bitwarden CLI (bw) against a Vaultwarden server. Master password: "correct horse".
import { die, load, logArgv, out, save, stdin } from './fake-vault.mjs';
logArgv('bw');
const a = process.argv.slice(2);
const d = load();
const unlocked = process.env.BW_SESSION === 'sess-ok';
const need = () => unlocked || die('Vault is locked.');
if (a[0] === '--version') out('2024.9.0\n');
else if (a[0] === 'status') out({ serverUrl: d.server ?? null, status: unlocked ? 'unlocked' : 'locked', userEmail: 'me@example.com' });
else if (a[0] === 'config') (d.server = a[2], save(d));
else if (a[0] === 'unlock') process.env[a[a.indexOf('--passwordenv') + 1]] === 'correct horse' ? out('sess-ok') : die('Invalid master password.');
else if (a[0] === 'lock' || a[0] === 'sync') out('');
else if (a[0] === 'list' && a[1] === 'folders') (need(), out(d.folder ? [{ id: 'f1', name: d.folder }] : []));
else if (a[0] === 'create' && a[1] === 'folder') {
  need();
  d.folder = JSON.parse(Buffer.from(await stdin(), 'base64').toString()).name;
  save(d);
  out({ id: 'f1', name: d.folder });
} else if ((a[0] === 'create' || a[0] === 'edit') && a[1] === 'item') {
  need();
  const item = JSON.parse(Buffer.from(await stdin(), 'base64').toString());
  const id = a[0] === 'edit' ? a[2] : 'bw' + ++d.n;
  d.items[id] = item.login.password;
  save(d);
  out({ id, name: item.name });
} else if (a[0] === 'get' && a[1] === 'password') (need(), a[2] in d.items ? out(d.items[a[2]]) : die('Not found.'));
else if (a[0] === 'delete' && a[1] === 'item') (need(), delete d.items[a[2]], save(d));
else die('unknown bw command ' + a.join(' '));
