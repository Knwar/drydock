#!/usr/bin/env node
// Stand-in for the 1Password CLI (op): vault get/create, item create (JSON on stdin)/delete, read, signout.
import { die, load, logArgv, out, save, stdin } from './fake-vault.mjs';
logArgv('op');
const a = process.argv.slice(2);
const d = load();
const flag = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
if (a[0] === '--version') out('2.30.0\n');
else if (a[0] === 'vault') out({ id: 'v1', name: a[2] });
else if (a[0] === 'signout') out('');
else if (a[0] === 'item' && a[1] === 'create') {
  const item = JSON.parse(await stdin());
  d.items[`op:${flag('--vault')}/${item.title}`] = item.fields.find((f) => f.id === 'credential').value;
  save(d);
  out({ id: 'i' + ++d.n, title: item.title });
} else if (a[0] === 'item' && a[1] === 'delete') {
  const k = `op:${flag('--vault')}/${a[2]}`;
  if (!(k in d.items)) die(`"${a[2]}" isn't an item`);
  delete d.items[k];
  save(d);
} else if (a[0] === 'read') {
  const m = /^op:\/\/([^/]+)\/([^/]+)\/credential$/.exec(a[a.length - 1]);
  const v = m && d.items[`op:${m[1]}/${m[2]}`];
  if (v === undefined || v === null) die('not found');
  out(v);
} else die('unknown op command ' + a.join(' '));
