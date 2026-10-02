/** The fixture app's manifest, generated from its source as any app's is. */
import { join } from 'node:path';

import { generate, resolveConfig } from '@ouispec/cli';

import { TABLE } from '../fixtures/good-ds/agent-controls';

export const FIXTURES = join(__dirname, '..', 'fixtures');

export async function fixtureManifest() {
  const result = await generate(
    resolveConfig(
      join(FIXTURES, 'app'),
      { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem: ['@kit/ds'], apiSpec: null, out: 'generated' },
      { controlTables: { '@kit/ds': TABLE }, catalogs: [] },
    ),
  );
  if (result.errors.length) throw new Error(`the fixture app does not generate: ${JSON.stringify(result.errors)}`);
  return result.manifest;
}
