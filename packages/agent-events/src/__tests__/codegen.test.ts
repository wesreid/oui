/**
 * Generated TypeScript: the types follow the document, and a name the
 * document lacks does not type-check. The generated module is compiled with
 * the real TypeScript compiler, together with code that uses it, so "the
 * build fails" is what is checked, not a string in the output.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { renderTypeScript } from '../codegen.js';
import { deskEvents } from './support/desk-events.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = join(SRC, '__virtual__', 'desk-events.ts');
const CONSUMER = join(SRC, '__virtual__', 'consumer.ts');

function generate(): string {
  return renderTypeScript(deskEvents(), {
    source: 'The desk fixture product.',
    names: { eventMap: 'DeskEventMap', eventNames: 'DESK_EVENT_NAMES' },
    typesFrom: join(SRC, 'index'),
  });
}

/** Type-check the generated module and `consumer` together; returns each error's message. */
function typeErrors(consumer: string): string[] {
  const files = new Map([
    [GENERATED, generate()],
    [CONSUMER, consumer],
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile, directoryExists } = host;
  host.getSourceFile = (name, version, ...rest) =>
    files.has(name) ? ts.createSourceFile(name, files.get(name)!, version) : getSourceFile.call(host, name, version, ...rest);
  host.fileExists = (name) => files.has(name) || fileExists.call(host, name);
  host.readFile = (name) => files.get(name) ?? readFile.call(host, name);
  host.directoryExists = (dir) => dir === dirname(GENERATED) || (directoryExists?.call(host, dir) ?? true);
  const program = ts.createProgram([GENERATED, CONSUMER], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && files.has(d.file.fileName))
    .map((d) => `${d.file!.fileName.endsWith('consumer.ts') ? 'consumer' : 'generated'}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

describe('TypeScript generated from a declaration document', () => {
  const source = generate();

  it('types every payload, extending the shared shapes it references', () => {
    expect(source).toContain('export interface ReportRef {');
    expect(source).toContain('export interface ReportReady extends ReportRef {');
    expect(source).toContain('  url: string;');
    expect(source).toContain('  pages?: number | null;');
    expect(source).toContain("  'report:ready': ReportReady;");
    expect(source).toContain("export const DESK_EVENT_NAMES = [\n  'report:ready',\n  'report:failed',\n  'report:progress',\n] as const");
  });

  it('builds rooms, the room check and the job kinds from the document', () => {
    expect(source).toContain('  export: (exportId: string) => `export:${exportId}`,');
    expect(source).toContain("  member: 'member:{userId}',");
    expect(source).toContain("    completion: 'report:ready',\n    failure: 'report:failed',\n    correlation: 'exportId',");
  });

  it('compiles, and code using the declared events compiles against it', () => {
    expect(
      typeErrors(`
        import { Room, isValidRoom, JOB_KINDS, type DeskEventMap, type EventPayload } from './desk-events';
        const ready: EventPayload<'report:ready'> = { exportId: 'x-1', url: 'https://files/x-1.pdf', pages: 3 };
        const failed: DeskEventMap['report:failed'] = { exportId: 'x-2', error: 'boom' };
        const room: string = Room.export(ready.exportId);
        const ok: boolean = isValidRoom(room);
        const completion: 'report:ready' = JOB_KINDS.export.completion;
        void [failed, ok, completion];
      `),
    ).toEqual([]);
  });

  it('fails the build on an undeclared event name, or a payload missing a required field', () => {
    const errors = typeErrors(`
      import type { EventPayload } from './desk-events';
      const done: EventPayload<'report:done'> = { exportId: 'x-1' };
      const ready: EventPayload<'report:ready'> = { exportId: 'x-1' };
      void [done, ready];
    `);
    expect(errors).toEqual([
      `consumer: Type '"report:done"' does not satisfy the constraint 'keyof DeskEventMap'.`,
      expect.stringMatching(/consumer: Property 'url' is missing in type/),
    ]);
  });

  it('refuses an invalid document instead of generating from it', () => {
    const doc = deskEvents();
    (doc.events as unknown as Record<string, { rooms: string[] }>)['report:ready'].rooms = ['nowhere'];
    expect(() => renderTypeScript(doc, { source: 'x' })).toThrow("room 'nowhere' is not declared");
  });
});
