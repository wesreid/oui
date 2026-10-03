#!/usr/bin/env node
/**
 * Writes src/version.ts from package.json, so what the package says its
 * version is (a session export's `sdkVersion`) is the version that was
 * published, not a string someone has to remember to change. Run before every
 * build, typecheck and test; the file is not committed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const text =
  `// Written by scripts/write-version.mjs from package.json. Not committed.\n` +
  `export const SDK_PACKAGE = ${JSON.stringify(name)};\n` +
  `export const SDK_VERSION = ${JSON.stringify(version)};\n`;
const file = join(PKG, 'src', 'version.ts');
let current = '';
try {
  current = readFileSync(file, 'utf8');
} catch {
  // Not written yet.
}
if (current !== text) writeFileSync(file, text);
