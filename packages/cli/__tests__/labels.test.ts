/**
 * A control's label, read from its JSX (ADR-0248 §2.7).
 *
 * The label names the action to the assistant. Read carelessly it came out as
 * an icon's class name ("animate-spin Render WAV", "text-[10px] shrink-0"), a
 * test id ("character-create-persona-path"), or an entity as written
 * ("&times;", "Use the character&apos;s own"): thirty actions of one app were
 * named that way, and an action the assistant cannot name it does not choose.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { decodeEntities, jsxText } from '../src/program.js';

/** The label of the first JSX element in `jsx`, read as the generator reads a control's children. */
function labelOf(jsx: string): string {
  const name = '/virtual/control.tsx';
  const text = `declare const busy: boolean; declare const count: number; declare const item: { name: string };\nconst LABEL = 'Publish';\nexport const el = ${jsx};\n`;
  const options: ts.CompilerOptions = { jsx: ts.JsxEmit.Preserve, noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...rest) =>
    file === name ? ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX) : read(file, ...rest);
  host.fileExists = file => file === name;
  host.readFile = file => (file === name ? text : undefined);
  const program = ts.createProgram([name], options, host);
  const source = program.getSourceFile(name)!;
  let element: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (!element && (ts.isJsxElement(n) || ts.isJsxFragment(n))) element = n;
    else ts.forEachChild(n, visit);
  };
  visit(source);
  if (!element) throw new Error('no JSX element');
  return jsxText(program.getTypeChecker(), element);
}

describe('a control’s label', () => {
  it('is its own text, a constant it shows, and the resting side of a conditional', () => {
    expect(labelOf('<Button>Save</Button>')).toBe('Save');
    expect(labelOf('<Button>\n  Save   as\n  template\n</Button>')).toBe('Save as template');
    expect(labelOf('<Button>{LABEL}</Button>')).toBe('Publish');
    expect(labelOf("<Button>{busy ? 'Saving…' : 'Save'}</Button>")).toBe('Save');
    expect(labelOf('<Button><>Save</></Button>')).toBe('Save');
  });

  it('never takes a nested element’s class name, test id or text for a word of it', () => {
    // Each of these came out with the attribute in the title.
    expect(labelOf('<Button>{busy ? <Loader className="animate-spin" /> : null} Render WAV</Button>')).toBe('Render WAV');
    expect(labelOf('<Button>{busy && <Loader className="h-3.5 w-3.5" />}Verify</Button>')).toBe('Verify');
    expect(labelOf('<Card>{count > 0 && <span className="text-[10px] shrink-0">{count}</span>}</Card>')).toBe('');
    expect(labelOf('<Row>{item.name ? <p data-testid="character-create-persona-path">{item.name}</p> : null}</Row>')).toBe('');
    // A nested element in the children was never read, and still is not.
    expect(labelOf('<Button><Icon name="plus" /> Add <Badge>3</Badge></Button>')).toBe('Add');
  });

  it('reads an entity as the character it shows', () => {
    expect(labelOf('<Button>Use the character&apos;s own</Button>')).toBe("Use the character's own");
    expect(labelOf('<Button>Generate &amp; Save</Button>')).toBe('Generate & Save');
    expect(decodeEntities('A&nbsp;B &#8212; C &#x2014; D &unknown; E')).toBe('A B — C — D &unknown; E');
  });

  it('gives no label when the text is only a symbol: such a control is named by its aria-label or its binding', () => {
    expect(labelOf('<Button>&times;</Button>')).toBe('');
    expect(labelOf('<Button>&#9733;</Button>')).toBe('');
    expect(labelOf('<Button>…</Button>')).toBe('');
    // A symbol beside words is part of the label.
    expect(labelOf('<Button>Next →</Button>')).toBe('Next →');
  });
});
