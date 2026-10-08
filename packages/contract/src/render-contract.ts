/**
 * What `scripts/generate.mjs` writes from `schemas/`: the contract's
 * TypeScript types, and the schemas as importable values. Pure: it takes the
 * parsed schema files and returns the text, so a test can hold the checked-in
 * output to the schemas.
 */
import { doc, renderNamed, type RenderableSchema, type RenderOptions } from './codegen.js';

/** Where every contract schema lives, by version: a path with no npm scope in it, so the packages can move without renaming it. */
export const CONTRACT_SCHEMA_HOST = 'https://schemas.closurestudio.ai';

/** One schema file of the contract, and how its types render. */
export interface ContractFile {
  file: string;
  /** The root type's name, or null when the file only holds `$defs`. Default: its `title`. */
  root?: string | null;
  /**
   * `readonly` for what a reader receives; `Array` where the hand-written
   * types the generated ones replace were mutable, so their users keep
   * compiling.
   */
  arrays?: 'readonly' | 'Array';
  /** The section heading in the generated file. */
  heading: string;
}

/**
 * Every schema of the contract, in dependency order. One major covers them
 * all (ADR-0226 §3.1): it is `MANIFEST_VERSION`, and it is in each `$id`.
 * The event declarations keep their own document version (W9) and `$id`.
 */
export const CONTRACT_FILES: readonly ContractFile[] = [
  { file: 'json-schema.json', heading: 'JSON Schema, as capabilities declare their inputs and values' },
  { file: 'action-effect.json', heading: 'What an action does (ADR-0226 §2.6), and how a job settles' },
  { file: 'agent-binding.json', heading: 'The binding a control carries (ADR-0220 §2.2)' },
  { file: 'control-kind-registration.json', heading: 'Control kinds, and the props their schemas come from' },
  { file: 'control-table.json', root: 'ControlTableFile', heading: 'A design system’s control table (ADR-0226 §2.2)' },
  { file: 'tier2-mapping.json', heading: 'A tier 2 mapping (ADR-0226 §2.3)' },
  { file: 'room-catalog-data.json', heading: 'A room catalog, as data (ADR-0220 §2.3)' },
  { file: 'oui-manifest.json', heading: 'The generated manifest' },
  { file: 'generated-knowledge.json', heading: 'The generated knowledge' },
  { file: 'oui-config.json', root: 'OuiConfigFile', heading: '`oui.config.json` (ADR-0226 §2.4)' },
  { file: 'approvals.json', root: null, arrays: 'Array', heading: 'Approvals (ADR-0228)' },
  { file: 'event-declarations.json', root: 'EventDeclarationDocument', heading: 'Event declarations (ADR-0227 §2.4)' },
  { file: 'conversation-takeover.json', root: null, arrays: 'Array', heading: 'Conversation takeover (ADR-0260 §2)' },
  { file: 'agent-evals.json', root: 'AgentEvalSuite', heading: 'Agent eval scenarios (ADR-0260 §3)' },
];

export type SchemaDocument = RenderableSchema & { $id: string; title: string; $defs?: Readonly<Record<string, RenderableSchema>> };

export interface RenderedContract {
  /** `src/generated/contract.ts`: every type. */
  types: string;
  /** `src/generated/schemas.ts`: every schema, as a value. */
  schemas: string;
  /** Type name → the schema reference it is generated from (`control-table.json#/$defs/ControlDescriptor`). */
  names: Readonly<Record<string, string>>;
}

const hasBody = (schema: RenderableSchema) =>
  ['type', 'properties', 'oneOf', 'anyOf', 'allOf', '$ref', 'enum', 'const'].some((k) => k in schema);

/** The version every `$id` of the contract carries, from the manifest's `version`. */
export function manifestVersion(docs: Readonly<Record<string, SchemaDocument>>): number {
  const version = (docs['oui-manifest.json']?.properties?.version as { const?: unknown } | undefined)?.const;
  if (typeof version !== 'number') throw new Error('oui-manifest.json: properties.version must be a const number: the contract major');
  return version;
}

/** Render the contract from its parsed schema files. Throws naming the first inconsistency. */
export function renderContract(docs: Readonly<Record<string, SchemaDocument>>, banner: string): RenderedContract {
  const version = manifestVersion(docs);
  const base = `${CONTRACT_SCHEMA_HOST}/oui/v${version}/`;

  // Every type's name, by the reference that names it.
  const names = new Map<string, string>();
  const byName = new Map<string, string>();
  const claim = (ref: string, name: string) => {
    const other = byName.get(name);
    if (other) throw new Error(`${ref} and ${other} would both generate the type ${name}`);
    byName.set(name, ref);
    names.set(ref, name);
  };
  for (const entry of CONTRACT_FILES) {
    const schema = docs[entry.file];
    if (!schema) throw new Error(`schemas/${entry.file} is missing`);
    if (entry.file !== 'event-declarations.json' && schema.$id !== `${base}${entry.file}`) {
      throw new Error(`schemas/${entry.file}: $id must be ${base}${entry.file} (the contract major is ${version})`);
    }
    const root = entry.root === undefined ? schema.title : entry.root;
    if (root && hasBody(schema)) claim(entry.file, root);
    for (const def of Object.keys(schema.$defs ?? {})) claim(`${entry.file}#/$defs/${def}`, def);
  }
  for (const file of Object.keys(docs)) {
    if (!CONTRACT_FILES.some((e) => e.file === file)) throw new Error(`schemas/${file} is not listed in CONTRACT_FILES`);
  }

  const resolverFor = (file: string) => (ref: string) => {
    const [target, pointer = ''] = ref.split('#');
    const targetFile = target || file;
    const key = pointer ? `${targetFile}#${pointer}` : targetFile;
    const name = names.get(key);
    if (!name) throw new Error(`schemas/${file}: $ref "${ref}" names no generated type`);
    return name;
  };

  let types = `// GENERATED FILE — DO NOT EDIT.\n//\n${banner
    .split('\n')
    .map((l) => `// ${l}`.trimEnd())
    .join('\n')}\n\n`;
  types += doc('The contract major. A breaking change to any schema of the contract bumps it, and it is in every `$id`.', '');
  types += `export const MANIFEST_VERSION = ${version};\n\n`;
  types += doc('Where the contract’s schemas are identified: each `$id` is this followed by the file name.', '');
  types += `export const CONTRACT_SCHEMA_BASE = '${base}';\n`;

  for (const entry of CONTRACT_FILES) {
    const schema = docs[entry.file];
    const options: RenderOptions = {
      refName: resolverFor(entry.file),
      arrays: entry.arrays ?? 'readonly',
      maps: (entry.arrays ?? 'readonly') === 'readonly' ? 'Record' : 'index',
      indexSignature: 'union',
    };
    types += `${types.endsWith('\n\n') ? '' : '\n'}// ─── ${entry.heading} ${'─'.repeat(Math.max(3, 74 - entry.heading.length))}\n// ${schema.$id}\n\n`;
    const root = names.get(entry.file);
    if (root) types += `${renderNamed(root, schema, undefined, options)}\n`;
    for (const [def, defSchema] of Object.entries(schema.$defs ?? {})) {
      types += `${renderNamed(def, defSchema, undefined, options)}\n`;
    }
  }
  types = types.replace(/\n+$/, '\n');

  let schemas = `// GENERATED FILE — DO NOT EDIT.\n//\n${banner
    .split('\n')
    .map((l) => `// ${l}`.trimEnd())
    .join('\n')}\n\n`;
  schemas += `import type { ContractSchemaDocument } from '../schema-document.js';\n\n`;
  schemas += doc('Every schema of the contract, by file name, exactly as `schemas/` holds it.', '');
  schemas += `export const CONTRACT_SCHEMAS = {\n`;
  for (const entry of CONTRACT_FILES) {
    const body = JSON.stringify(docs[entry.file], null, 2).replace(/\n/g, '\n  ');
    schemas += `  '${entry.file}': ${body} as ContractSchemaDocument,\n`;
  }
  schemas += `} as const;\n\n`;
  schemas += `export type ContractSchemaFile = keyof typeof CONTRACT_SCHEMAS;\n\n`;
  schemas += doc('Each generated type, by name, and the schema it is generated from (`file`, or `file#/$defs/Name`).', '');
  schemas += `export const CONTRACT_TYPES = {\n`;
  for (const [ref, name] of [...names.entries()]) schemas += `  ${name}: '${ref}',\n`;
  schemas += `} as const;\n\n`;
  schemas += `export type ContractTypeName = keyof typeof CONTRACT_TYPES;\n`;

  return { types, schemas, names: Object.fromEntries([...names.entries()].map(([ref, name]) => [name, ref])) };
}
