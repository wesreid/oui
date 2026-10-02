/**
 * The integrator guide (ADR-0226 §3.3), generated alongside the schemas: the
 * prose sections in `guide/`, in file-name order, with every schema they name
 * expanded into a reference generated from that schema. A field added to a
 * schema is in the guide on the next generation; a section can never describe
 * a field the schema does not have.
 *
 * Directives, each on a line of its own:
 * - `<!-- schema: <file>[#/$defs/<Name>] -->`: the schema's link, `$id`, type
 *   and a table of its fields;
 * - `<!-- schemas -->`: every schema of the contract, with its `$id`.
 */
import type { RenderableSchema } from './codegen.js';
import { CONTRACT_FILES, manifestVersion, type SchemaDocument } from './render-contract.js';

const SCHEMA_DIRECTIVE = /^<!-- schema: ([a-z0-9-]+\.json)(?:#\/\$defs\/([A-Za-z0-9]+))? -->$/;
const SCHEMAS_DIRECTIVE = '<!-- schemas -->';

/** The first sentence of a description, on one line, for a table cell. */
function firstSentence(text: string | undefined): string {
  if (!text) return '';
  const flat = text.split('\n\n')[0].replace(/\s*\n\s*/g, ' ');
  const end = flat.search(/[.!?](\s|$)/);
  return (end === -1 ? flat : flat.slice(0, end + 1)).replace(/\|/g, '\\|');
}

/** A short type for a table cell: a name, a literal union, or `T[]`. */
function shortType(schema: RenderableSchema, nameOf: (ref: string) => string): string {
  const stated = typeof schema.$comment === 'string' ? /^ts:\s*(.+)$/s.exec(schema.$comment.trim())?.[1] : undefined;
  if (stated) return stated;
  if (typeof schema.$ref === 'string') return nameOf(schema.$ref);
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum) {
    const values = schema.enum.map(v => JSON.stringify(v));
    return values.length > 6 ? `${values.slice(0, 6).join(' \\| ')} \\| …` : values.join(' \\| ');
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return union.map(s => shortType(s, nameOf)).join(' \\| ');
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type as string];
  const inline = () => {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(
      ([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${shortType(v, nameOf)}`,
    );
    return `{ ${fields.join(', ')} }`;
  };
  if (!types.length) return schema.properties ? inline() : 'any';
  return types
    .map(type => {
      if (type === 'array') return schema.items ? `${shortType(schema.items, nameOf)}[]` : 'array';
      if (type === 'object' && !schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return `map of ${shortType(schema.additionalProperties, nameOf)}`;
      }
      if (type === 'object' && schema.properties) return inline();
      return type;
    })
    .join(' \\| ');
}

/** Render the guide from the parsed schemas and the prose sections, by file name. */
export function renderGuide(docs: Readonly<Record<string, SchemaDocument>>, sections: Readonly<Record<string, string>>): string {
  const version = manifestVersion(docs);

  // The type each schema and definition generates, to name in the tables.
  const names = new Map<string, string>();
  for (const entry of CONTRACT_FILES) {
    const schema = docs[entry.file];
    if (!schema) throw new Error(`schemas/${entry.file} is missing`);
    const root = entry.root === undefined ? schema.title : entry.root;
    if (root) names.set(entry.file, root);
    for (const def of Object.keys(schema.$defs ?? {})) names.set(`${entry.file}#/$defs/${def}`, def);
  }
  const nameIn = (file: string) => (ref: string) => {
    const [target, pointer] = ref.split('#');
    const key = pointer ? `${target || file}#${pointer}` : target || file;
    return names.get(key) ?? (key === `${file}` ? names.get(file)! : ref);
  };

  const reference = (file: string, def: string | undefined): string => {
    const doc = docs[file];
    if (!doc) throw new Error(`the guide names schemas/${file}, which does not exist`);
    const schema = def ? doc.$defs?.[def] : doc;
    if (!schema) throw new Error(`the guide names ${file}#/$defs/${def}, which does not exist`);
    const typeName = def ?? names.get(file) ?? doc.title;
    const id = def ? `${doc.$id}#/$defs/${def}` : doc.$id;
    const nameOf = nameIn(file);
    const lines = [
      `> **Schema:** [\`${file}${def ? `#/$defs/${def}` : ''}\`](schemas/${file}) · \`${id}\` · TypeScript: \`${typeName}\` from \`@ouispec/contract\``,
    ];
    const parts = [schema, ...((schema.allOf as RenderableSchema[] | undefined) ?? [])];
    const props = parts.flatMap(p => Object.entries((p.$ref ? docs[file].$defs?.[p.$ref.split('/').pop()!]?.properties : undefined) ?? p.properties ?? {}));
    const required = new Set(parts.flatMap(p => [
      ...((p.required as string[] | undefined) ?? []),
      ...((p.$ref ? docs[file].$defs?.[p.$ref.split('/').pop()!]?.required : undefined) ?? []),
    ]));
    if (props.length) {
      lines.push('>', '> | Field | Type | Required | What it is |', '> |---|---|---|---|');
      for (const [field, prop] of props) {
        lines.push(`> | \`${field}\` | ${shortType(prop, nameOf)} | ${required.has(field) ? 'yes' : ''} | ${firstSentence(prop.description)} |`);
      }
      const extra = schema.additionalProperties;
      if (extra && typeof extra === 'object') lines.push(`> | *any other key* | ${shortType(extra, nameOf)} | | ${firstSentence(extra.description)} |`);
    } else if (schema.oneOf || schema.anyOf || schema.enum) {
      lines.push('>', `> One of: ${shortType(schema, nameOf)}.`);
    }
    return lines.join('\n');
  };

  const index = (): string => {
    const lines = ['| Schema | TypeScript | `$id` |', '|---|---|---|'];
    for (const entry of CONTRACT_FILES) {
      const doc = docs[entry.file];
      const root = names.get(entry.file);
      const typeName = root ? `\`${root}\`` : `its ${Object.keys(doc.$defs ?? {}).length} \`$defs\`, one type each`;
      lines.push(`| [\`${entry.file}\`](schemas/${entry.file}) | ${typeName} | \`${doc.$id}\` |`);
    }
    return lines.join('\n');
  };

  const files = Object.keys(sections).sort();
  if (!files.length) throw new Error('guide/ has no sections');
  const body = files
    .map(file =>
      sections[file]
        .trimEnd()
        .split('\n')
        .map(line => {
          const t = line.trim();
          if (t === SCHEMAS_DIRECTIVE) return index();
          const m = SCHEMA_DIRECTIVE.exec(t);
          return m ? reference(m[1], m[2]) : line;
        })
        .join('\n'),
    )
    .join('\n\n');
  return (
    `<!-- GENERATED FILE — DO NOT EDIT. Generated from guide/*.md and schemas/*.json by @ouispec/contract (contract major ${version}).\n` +
    `     Edit the sections or the schemas, then: pnpm generate (in packages/agent-sdk/oui-contract). -->\n\n` +
    `${body}\n`
  );
}
