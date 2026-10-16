// Shared store for the fake password-manager CLIs used in tests. Items live in
// a JSON file (FAKE_VAULT); every call's argv is appended to FAKE_VAULT.argv so
// tests can check that no secret value was ever passed as an argument.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const file = process.env.FAKE_VAULT;
export const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { items: {}, keychain: {}, n: 0 });
export const save = (d) => writeFileSync(file, JSON.stringify(d));
export const logArgv = (tool) => appendFileSync(file + '.argv', JSON.stringify([tool, ...process.argv.slice(2)]) + '\n');
export const stdin = async () => {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
};
export const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
export const die = (msg, code = 1) => (process.stderr.write(msg + '\n'), process.exit(code));
