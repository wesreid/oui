import { parse as parseYaml } from 'yaml';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import type { RawSchemaDocument, SchemaLoadOptions, SchemaSource } from './types.js';

const DEFAULT_EXTENSIONS = ['.yaml', '.yml', '.json'];

/**
 * Load schema documents from a directory, file list, or inline objects.
 * Resolves $ref pointers to produce a flat list of raw schema documents.
 */
export async function loadSchemas(source: string | SchemaSource): Promise<RawSchemaDocument[]> {
  const normalized = normalizeSource(source);

  switch (normalized.type) {
    case 'directory':
      return loadFromDirectory(normalized.path, normalized.options);
    case 'files':
      return loadFromFiles(normalized.paths);
    case 'inline':
      return normalized.documents;
  }
}

function normalizeSource(source: string | SchemaSource): SchemaSource {
  if (typeof source === 'string') {
    return { type: 'directory', path: source };
  }
  return source;
}

async function loadFromDirectory(
  dirPath: string,
  options?: SchemaLoadOptions,
): Promise<RawSchemaDocument[]> {
  const extensions = options?.extensions ?? DEFAULT_EXTENSIONS;
  const recursive = options?.recursive ?? true;
  const basePath = options?.basePath ?? dirPath;

  const files = await collectFiles(dirPath, extensions, recursive);
  const documents: RawSchemaDocument[] = [];

  for (const filePath of files) {
    const doc = await parseSchemaFile(filePath);
    if (doc) {
      const resolved = await resolveRefs(doc, basePath);
      documents.push(resolved);
    }
  }

  return documents;
}

async function loadFromFiles(paths: string[]): Promise<RawSchemaDocument[]> {
  const documents: RawSchemaDocument[] = [];
  for (const filePath of paths) {
    const doc = await parseSchemaFile(filePath);
    if (doc) {
      const basePath = resolve(filePath, '..');
      const resolved = await resolveRefs(doc, basePath);
      documents.push(resolved);
    }
  }
  return documents;
}

async function collectFiles(
  dirPath: string,
  extensions: string[],
  recursive: boolean,
): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory() && recursive) {
      const subFiles = await collectFiles(fullPath, extensions, recursive);
      files.push(...subFiles);
    } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function parseSchemaFile(filePath: string): Promise<RawSchemaDocument | null> {
  const content = await readFile(filePath, 'utf-8');
  const ext = extname(filePath);

  if (ext === '.json') {
    return JSON.parse(content) as RawSchemaDocument;
  }

  if (ext === '.yaml' || ext === '.yml') {
    return parseYaml(content) as RawSchemaDocument;
  }

  return null;
}

/**
 * Resolve $ref pointers in a schema document.
 * Supports: { $ref: "./path/to/file.yaml" } references within arrays.
 */
async function resolveRefs(doc: RawSchemaDocument, basePath: string): Promise<RawSchemaDocument> {
  if (doc.domain) {
    if (doc.domain.entities) {
      doc.domain.entities = (await resolveRefArray(doc.domain.entities, basePath)) as typeof doc.domain.entities;
    }
    if (doc.domain.intents) {
      doc.domain.intents = (await resolveRefArray(doc.domain.intents, basePath)) as typeof doc.domain.intents;
    }
    if (doc.domain.workflows) {
      doc.domain.workflows = (await resolveRefArray(doc.domain.workflows, basePath)) as typeof doc.domain.workflows;
    }
  }
  return doc;
}

async function resolveRefArray(items: Array<unknown>, basePath: string): Promise<Array<unknown>> {
  const resolved: unknown[] = [];
  for (const item of items) {
    if (isRef(item)) {
      const refPath = resolve(basePath, item.$ref);
      const refDoc = await parseSchemaFile(refPath);
      if (refDoc) {
        const innerResolved = await resolveRefs(refDoc, resolve(refPath, '..'));
        resolved.push(innerResolved.entity ?? innerResolved.intent ?? innerResolved.workflow ?? innerResolved);
      }
    } else {
      resolved.push(item);
    }
  }
  return resolved;
}

function isRef(value: unknown): value is { $ref: string } {
  return typeof value === 'object' && value !== null && '$ref' in value;
}
