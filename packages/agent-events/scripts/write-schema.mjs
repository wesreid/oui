#!/usr/bin/env node
/**
 * Publish the declaration document's JSON Schema as a file
 * (`@ouispec/agent-events/schema.json`), written from the same
 * object the catalog validates with, so the two cannot differ.
 */
import { writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { EVENT_DECLARATIONS_SCHEMA, EVENT_DECLARATIONS_VERSION } = await import(join(DIST, 'index.js'));

const file = join(DIST, `event-declarations.v${EVENT_DECLARATIONS_VERSION}.schema.json`);
writeFileSync(file, JSON.stringify(EVENT_DECLARATIONS_SCHEMA, null, 2) + '\n');
chmodSync(join(DIST, 'cli.js'), 0o755);
console.log(`wrote ${file}`);
