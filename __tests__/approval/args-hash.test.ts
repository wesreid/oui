/**
 * The approval args hash: SHA-256 over the RFC 8785 (JCS) canonical JSON of a
 * request's params. The agent runtime, the approval store and this runtime
 * compute it identically, and the published vectors hold every implementation
 * to it. The vectors were computed independently of this code (`provenance`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { argsHash, canonicalJson } from '../../src/spec/approval.js';

interface VectorFile {
  vectors: Array<{ name: string; json: string; canonical: string; sha256: string }>;
  invalid: Array<{ name: string; json: string }>;
}
const file = JSON.parse(readFileSync(new URL('../../spec/approval-vectors.json', import.meta.url), 'utf8')) as VectorFile;

describe('the published vectors', () => {
  it('cover key order, Unicode, numbers, nested arrays and empty objects', () => {
    const names = file.vectors.map(v => v.name).join(' | ');
    for (const topic of ['key order', 'Unicode', 'numbers', 'nested arrays', 'empty object']) expect(names).toContain(topic);
  });

  it.each(file.vectors.map(v => [v.name, v] as const))('%s', async (_name, v) => {
    expect(canonicalJson(JSON.parse(v.json))).toBe(v.canonical);
    expect(await argsHash(JSON.parse(v.json))).toBe(v.sha256);
  });

  it.each(file.invalid.map(v => [v.name, v.json] as const))('refuses %s', async (_name, json) => {
    expect(() => canonicalJson(JSON.parse(json))).toThrow(/not I-JSON/);
    await expect(argsHash(JSON.parse(json))).rejects.toThrow();
  });

  it('refuses what JSON cannot carry, and leaves out undefined members as the wire does', () => {
    for (const bad of [NaN, Infinity, 10n, () => 1, new Date(0), [undefined]]) expect(() => canonicalJson({ v: bad })).toThrow();
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });
});
