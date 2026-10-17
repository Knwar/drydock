#!/usr/bin/env node
// Refresh the board protocol block inside a target CLAUDE.md, in place.
//   node replace-block.js <target CLAUDE.md> <source CLAUDE.md>
// Replaces whatever is between the markers with the current source (older
// installs used kankan:begin/end; they are rewritten to the current ones).
// Prints `updated` if it replaced the block, or `manual` if the target has
// no markers (a legacy/pristine file we won't risk overwriting).
import { readFileSync, writeFileSync } from 'node:fs';

const [targetPath, sourcePath] = process.argv.slice(2);
const BEGIN = '<!-- kanban:begin -->';
const END = '<!-- kanban:end -->';
const ANY = /<!-- kan(?:kan|ban):begin -->[\s\S]*?<!-- kan(?:kan|ban):end -->/;

const target = readFileSync(targetPath, 'utf8');
if (!ANY.test(target)) {
  console.log('manual');
  process.exit(0);
}

const source = readFileSync(sourcePath, 'utf8').trimEnd();
const block = `${BEGIN}\n${source}\n${END}`;
writeFileSync(targetPath, target.replace(ANY, () => block));
console.log('updated');
