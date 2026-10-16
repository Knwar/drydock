#!/usr/bin/env node
// Stand-in for the Bitwarden Secrets Manager CLI (bws). Valid token: "0.machine.token-for-tests".
import { die, load, logArgv, out, save } from './fake-vault.mjs';
logArgv('bws');
const a = process.argv.slice(2).filter((x, i, all) => !['--output', '--color'].includes(x) && !['--output', '--color'].includes(all[i - 1]));
const d = load();
if (a[0] === '--version') out('bws 1.0.0\n');
else if (process.env.BWS_ACCESS_TOKEN !== '0.machine.token-for-tests') die('[400 Bad Request] invalid token');
else if (a[0] === 'project' && a[1] === 'list') out([{ id: 'proj-1', name: 'ai-brain' }]);
else if (a[0] === 'secret' && a[1] === 'create') {
  const id = 'bws' + ++d.n;
  d.items[id] = a[3];
  save(d);
  out({ id, key: a[2], value: a[3] });
} else if (a[0] === 'secret' && a[1] === 'edit') {
  d.items[a[2]] = a[a.indexOf('--value') + 1];
  save(d);
  out({ id: a[2] });
} else if (a[0] === 'secret' && a[1] === 'get') (a[2] in d.items ? out({ id: a[2], value: d.items[a[2]] }) : die('not found'));
else if (a[0] === 'secret' && a[1] === 'delete') (delete d.items[a[2]], save(d), out(''));
else die('unknown bws command ' + a.join(' '));
