#!/usr/bin/env node
// brain security-scan [dir] — automated checks before any human-style
// security review (Microsoft SDL / AWS "guardrails over gates"):
//   1. dependency audit: npm audit (package-lock.json), pip-audit if installed
//   2. secret scan: likely credentials in git-tracked files
//   3. SAST: Semgrep (auto config) if installed
// Prints a Markdown report; exits 1 when anything high or critical is found.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? process.cwd());
const out = [`# Security scan · ${dir}`, ''];
let serious = 0;
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

// 1. dependencies
out.push('## Dependencies');
if (existsSync(join(dir, 'package-lock.json'))) {
  const r = spawnSync('npm', ['audit', '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 20_000_000 });
  try {
    const v = JSON.parse(r.stdout).metadata?.vulnerabilities ?? {};
    const high = (v.high ?? 0) + (v.critical ?? 0);
    serious += high;
    out.push(`- npm audit: ${v.critical ?? 0} critical, ${v.high ?? 0} high, ${v.moderate ?? 0} moderate, ${v.low ?? 0} low${high ? ' — run `npm audit` for details and fix' : ''}`);
  } catch {
    out.push('- npm audit: could not read the result');
  }
} else out.push('- npm: no package-lock.json');
if (existsSync(join(dir, 'requirements.txt')) || existsSync(join(dir, 'pyproject.toml'))) {
  if (has('pip-audit')) {
    const r = spawnSync('pip-audit', ['-f', 'json'], { cwd: dir, encoding: 'utf8' });
    try {
      const deps = JSON.parse(r.stdout).dependencies ?? [];
      const vulns = deps.reduce((n, d) => n + (d.vulns?.length ?? 0), 0);
      serious += vulns;
      out.push(`- pip-audit: ${vulns} known vulnerabilities`);
    } catch {
      out.push('- pip-audit: could not read the result');
    }
  } else out.push('- Python: pip-audit not installed (pipx install pip-audit)');
}
out.push('');

// 2. secrets in tracked files
out.push('## Secrets');
const PATTERNS = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Private key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe live key', /sk_live_[A-Za-z0-9]{20,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Generic secret assignment', /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
];
let files = [];
try {
  files = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  out.push('- not a git repository: secret scan skipped');
}
const hits = [];
for (const f of files) {
  if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|lock|woff2?)$/i.test(f) || /(^|\/)(node_modules|dist)\//.test(f)) continue;
  const p = join(dir, f);
  try {
    if (statSync(p).size > 1_000_000) continue;
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [name, re] of PATTERNS) if (re.test(line) && !/example|placeholder|dummy|xxxx/i.test(line)) hits.push(`- ${name}: ${f}:${i + 1}`);
    });
  } catch {
    /* unreadable */
  }
}
serious += hits.length;
out.push(...(hits.length ? hits.slice(0, 50) : files.length ? ['- none found'] : []), '');

// 3. static analysis
out.push('## Static analysis');
if (has('semgrep')) {
  const r = spawnSync('semgrep', ['--config', 'auto', '--json', '--quiet', dir], { encoding: 'utf8', maxBuffer: 50_000_000 });
  try {
    const results = JSON.parse(r.stdout).results ?? [];
    const high = results.filter((x) => ['ERROR'].includes(x.extra?.severity));
    serious += high.length;
    out.push(`- Semgrep: ${results.length} findings, ${high.length} high`);
    for (const x of results.slice(0, 30)) out.push(`  - [${x.extra?.severity}] ${x.check_id.split('.').pop()}: ${x.path}:${x.start?.line} — ${String(x.extra?.message ?? '').slice(0, 140)}`);
  } catch {
    out.push('- Semgrep: could not read the result');
  }
} else out.push('- Semgrep not installed: install with `pipx install semgrep` or `brew install semgrep` for code scanning');
out.push('', serious ? `**Result: ${serious} high or critical issue(s) need attention.**` : '**Result: clean (nothing high or critical).**');
console.log(out.join('\n'));
process.exit(serious ? 1 : 0);
