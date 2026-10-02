/**
 * A design-system package as it ships: its `package.json`, and the control
 * table its declaration names (`oui.agentControls`, or `closure.agentControls`
 * during the transition), read from disk exactly as an app's generator reads it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { agentDeclaration } from '@ouispec/bindings';

export interface ShippedPackage {
  name: string;
  packageJson: Readonly<Record<string, unknown>>;
  /** The control table file's contents; `undefined` when the declaration names none, or a file that is not there. */
  table: unknown;
}

/** Read a built package's `package.json` and the control table it declares. Build the package first. */
export function readShippedPackage(dir: string): ShippedPackage {
  const packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  const name = typeof packageJson.name === 'string' ? packageJson.name : dir;
  const declared = agentDeclaration(name, packageJson, 'agentControls');
  let table: unknown;
  if (typeof declared.value === 'string') {
    const file = resolve(dir, declared.value);
    if (!existsSync(file)) throw new Error(`${name} names ${declared.value} as its ${declared.source}, but it is not there: build the package first`);
    table = JSON.parse(readFileSync(file, 'utf8'));
  }
  return { name, packageJson, table };
}
