#!/usr/bin/env node
// Stand-in for macOS `security`: -i (commands on stdin), find-/delete-generic-password.
import { die, load, logArgv, out, save, stdin } from './fake-vault.mjs';
logArgv('security');
const a = process.argv.slice(2);
const d = load();
const key = (args) => `${args[args.indexOf('-a') + 1]}|${args[args.indexOf('-s') + 1]}`;
if (a[0] === '-i') {
  const line = (await stdin()).trim();
  const args = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  if (args[0] !== 'add-generic-password') die('unsupported');
  d.keychain[key(args)] = args[args.indexOf('-w') + 1];
  save(d);
} else if (a[0] === 'find-generic-password') (key(a) in d.keychain ? out(d.keychain[key(a)] + '\n') : die('The specified item could not be found in the keychain.', 44));
else if (a[0] === 'delete-generic-password') (delete d.keychain[key(a)], save(d));
else die('unsupported');
