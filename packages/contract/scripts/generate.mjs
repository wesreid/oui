#!/usr/bin/env node
/**
 * Generate src/generated/contract.ts (the types) and src/generated/schemas.ts
 * (the schemas as values) from schemas/*.json, and INTEGRATOR-GUIDE.md from
 * guide/*.md and the schemas. The schemas are the authority; everything else
 * follows them (ADR-0226 §3.1, §3.3).
 *
 *   node scripts/generate.mjs           write the files
 *   node scripts/generate.mjs --check   exit 1 if any file is stale
 *
 * Runs against the built renderer in dist/, so `pnpm build` compiles first.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const { renderContract } = await import(join(PKG, 'dist', 'render-contract.js'));
const { renderGuide } = await import(join(PKG, 'dist', 'render-guide.js'));

const read = (dir) =>
  Object.fromEntries(
    readdirSync(join(PKG, dir))
      .filter((f) => f.endsWith(dir === 'schemas' ? '.json' : '.md'))
      .sort()
      .map((f) => [f, readFileSync(join(PKG, dir, f), 'utf8')]),
  );

const schemas = Object.fromEntries(Object.entries(read('schemas')).map(([f, text]) => [f, JSON.parse(text)]));
const banner =
  'Generated from schemas/*.json, the OUI integrator contract, by @ouispec/contract.\n' +
  'Edit the schemas, then: pnpm generate (in packages/contract).';
const { types, schemas: values } = renderContract(schemas, banner);
const guide = renderGuide(schemas, read('guide'));

const outputs = [
  ['src/generated/contract.ts', types],
  ['src/generated/schemas.ts', values],
  ['INTEGRATOR-GUIDE.md', guide],
];

let stale = 0;
for (const [file, text] of outputs) {
  const path = join(PKG, file);
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // Missing is as stale as wrong.
    }
    if (current !== text) {
      console.error(`${file} is not what the schemas generate. Run: pnpm generate`);
      stale++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${file}`);
  }
}
if (stale) process.exit(1);
if (process.argv.includes('--check')) console.log('the generated types, schemas and guide are current');
