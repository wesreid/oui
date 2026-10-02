#!/usr/bin/env node
/**
 * agent-sdk-events — check a declaration document, and generate its TypeScript.
 *
 *   agent-sdk-events check <document.json>...
 *     Exits 1, listing every problem, unless each document is valid on its own
 *     and all of them together (with the platform's events) make one catalog.
 *
 *   agent-sdk-events types <document.json> --out <file.ts> [--names key=Name,...] [--source <text>] [--check]
 *     Writes the generated TypeScript. With --check, writes nothing and exits 1
 *     when <file.ts> is not what the document generates now.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createEventCatalog, EventDeclarationError } from './catalog.js';
import { PLATFORM_EVENTS } from './platform.js';
import { renderTypeScript, type TypeScriptNames } from './codegen.js';
import type { EventDeclarationDocument } from './types.js';

function readDocument(path: string): EventDeclarationDocument {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EventDeclarationDocument;
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function run(args: string[]): number {
  const [command, ...rest] = args;
  if (command === 'check') {
    const files = rest.filter((a) => !a.startsWith('--'));
    if (files.length === 0) throw new Error('check needs at least one document');
    createEventCatalog(PLATFORM_EVENTS, ...files.map(readDocument));
    console.log(`event declarations valid: ${files.join(', ')}`);
    return 0;
  }
  if (command === 'types') {
    const file = rest[0];
    const out = option(rest, '--out');
    if (!file || !out) throw new Error('types needs <document.json> --out <file.ts>');
    const names = Object.fromEntries(
      (option(rest, '--names') ?? '')
        .split(',')
        .filter(Boolean)
        .map((pair) => pair.split('=') as [keyof TypeScriptNames, string]),
    );
    const source = option(rest, '--source') ?? `Generated from ${file} by agent-sdk-events. Edit the document, then regenerate.`;
    const text = renderTypeScript(readDocument(file), { source, names });
    if (rest.includes('--check')) {
      let current = '';
      try {
        current = readFileSync(out, 'utf8');
      } catch {
        // A missing file is as stale as a wrong one.
      }
      if (current !== text) {
        console.error(`${out} is not what ${file} generates. Regenerate it: agent-sdk-events types ${file} --out ${out}`);
        return 1;
      }
      console.log(`${out} is current`);
      return 0;
    }
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
    return 0;
  }
  throw new Error(`unknown command '${command ?? ''}'; use check or types`);
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof EventDeclarationError ? err.message : `agent-sdk-events: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
