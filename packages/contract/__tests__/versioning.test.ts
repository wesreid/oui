/**
 * The contract's version follows MANIFEST_VERSION (VERSIONING.md): from 1.0
 * its major is MANIFEST_VERSION, and before 1.0 MANIFEST_VERSION is 1, so
 * 1.0.0 is released as the contract already in use.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CONTRACT_SCHEMA_BASE, MANIFEST_VERSION } from '../src/index.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const major = Number(version.split('.')[0]);

describe('the contract version', () => {
  it('is the manifest version from 1.0, and manifest version 1 before it', () => {
    expect(Number.isInteger(major)).toBe(true);
    expect(MANIFEST_VERSION).toBe(major === 0 ? 1 : major);
  });

  it('names the manifest version in every schema id', () => {
    expect(CONTRACT_SCHEMA_BASE.endsWith(`/v${MANIFEST_VERSION}/`)).toBe(true);
  });
});
