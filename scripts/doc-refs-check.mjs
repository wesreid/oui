#!/usr/bin/env node
/**
 * Everything in this repository is public, so its source and docs refer only
 * to what a reader can open: this repository, the spec in
 * `packages/oui-spec/spec/`, and public links. This check fails on a
 * reference to a numbered design record or a session id, neither of which
 * exists here.
 *
 *   node scripts/doc-refs-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './workspace.mjs';

const PATTERNS = [
  { name: 'design record number', re: /\bADR[- ]?\d{2,4}\b/ },
  { name: 'session id', re: /\bsession [0-9a-f]{8}\b/i },
];

const SKIP = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|woff2?|ttf)$/];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(file => file && !SKIP.some(re => re.test(file)));

const problems = [];
for (const file of files) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const { name, re } of PATTERNS) {
      const match = line.match(re);
      if (match) problems.push(`${file}:${index + 1}: ${name} "${match[0]}"`);
    }
  });
}

if (problems.length > 0) {
  console.error(`Refers to a document outside this repository:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`doc-refs-check: ${files.length} files, no outside references`);
