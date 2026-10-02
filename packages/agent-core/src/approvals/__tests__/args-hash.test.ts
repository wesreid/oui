/**
 * ADR-0228 §5.8, the TypeScript side: the args hash the worker, the approval
 * store and the browser all compute is the published one, and the one this
 * package exports is oui-spec's. Every vector's input
 * canonicalizes to exactly its canonical form and hashes to exactly its hash;
 * every invalid input is refused. The vectors were computed independently of
 * this implementation (see the file's `provenance`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { argsHash, canonicalJson } from '../args-hash.js';
import * as browserEntry from '../../browser.js';

interface VectorFile {
  version: number;
  vectors: Array<{ name: string; json: string; canonical: string; sha256: string }>;
  invalid: Array<{ name: string; json: string }>;
}

// Published with oui-spec, which defines the hash this package re-exports.
const file = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve('oui-spec/approval-vectors.json'), 'utf8'),
) as VectorFile;

describe('the published args-hash vectors', () => {
  it('cover key order, Unicode, numbers, nested arrays and empty objects', () => {
    const names = file.vectors.map((v) => v.name).join(' | ');
    for (const topic of ['key order', 'Unicode', 'numbers', 'nested arrays', 'empty object']) expect(names).toContain(topic);
    expect(file.invalid.length).toBeGreaterThan(0);
  });

  describe.each(file.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    it('canonicalizes to exactly the published form', () => {
      expect(canonicalJson(JSON.parse(vector.json))).toBe(vector.canonical);
    });
    it('hashes to exactly the published hash, on the server and in the browser build', async () => {
      const value = JSON.parse(vector.json);
      expect(await argsHash(value)).toBe(vector.sha256);
      expect(await browserEntry.argsHash(value)).toBe(vector.sha256);
    });
  });

  it.each(file.invalid.map((v) => [v.name, v.json] as const))('refuses %s', async (_name, json) => {
    const value = JSON.parse(json);
    expect(() => canonicalJson(value)).toThrow(/not I-JSON|lone surrogate/);
    await expect(argsHash(value)).rejects.toThrow();
  });
});

describe('canonicalJson on values that never went through JSON', () => {
  it('refuses what JSON cannot carry, rather than hashing something the other end never sees', () => {
    for (const bad of [NaN, Infinity, -Infinity, 10n, () => 1, Symbol('x'), new Date(0), new Map(), [undefined]]) {
      expect(() => canonicalJson({ v: bad })).toThrow();
    }
    expect(() => canonicalJson(undefined)).toThrow();
  });

  it('leaves out an object member whose value is undefined, as the wire does', () => {
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  it('hashes the same arguments the same way whatever order their keys were written in', async () => {
    expect(await argsHash({ quantity: 100, symbol: 'ACME', side: 'buy' })).toBe(
      await argsHash({ side: 'buy', symbol: 'ACME', quantity: 100 }),
    );
    expect(await argsHash({ quantity: 100 })).not.toBe(await argsHash({ quantity: 101 }));
  });
});
