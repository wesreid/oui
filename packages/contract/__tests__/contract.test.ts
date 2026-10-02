/**
 * The published contract (ADR-0226 §3.1): the schemas are the authority, the
 * TypeScript follows them, one major versions them all, and each schema
 * accepts what the ADR specifies and refuses what it forbids.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  CONTRACT_FILES,
  CONTRACT_SCHEMAS,
  CONTRACT_SCHEMA_BASE,
  CONTRACT_TYPES,
  MANIFEST_VERSION,
  type OuiConfigFile,
  type Tier2Mapping,
} from '../src/index.js';
import { renderContract, type SchemaDocument } from '../src/render-contract.js';
import { renderGuide } from '../src/render-guide.js';
import { contractProblems, contractSchemaId, createContractValidator } from '../src/validate.js';

const PKG = join(__dirname, '..');
const onDisk = Object.fromEntries(
  readdirSync(join(PKG, 'schemas'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(join(PKG, 'schemas', f), 'utf8')) as SchemaDocument]),
);

describe('the schemas are the authority', () => {
  it('generates exactly the checked-in types and schema values', () => {
    const banner =
      'Generated from schemas/*.json, the OUI integrator contract, by @ouispec/contract.\n' +
      'Edit the schemas, then: pnpm generate (in packages/agent-sdk/oui-contract).';
    const { types, schemas } = renderContract(onDisk, banner);
    expect(types).toBe(readFileSync(join(PKG, 'src/generated/contract.ts'), 'utf8'));
    expect(schemas).toBe(readFileSync(join(PKG, 'src/generated/schemas.ts'), 'utf8'));
  });

  it('generates exactly the checked-in integrator guide, and the guide links every schema', () => {
    const sections = Object.fromEntries(
      readdirSync(join(PKG, 'guide'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => [f, readFileSync(join(PKG, 'guide', f), 'utf8')]),
    );
    const guide = renderGuide(onDisk, sections);
    expect(guide).toBe(readFileSync(join(PKG, 'INTEGRATOR-GUIDE.md'), 'utf8'));
    for (const { file } of CONTRACT_FILES) expect(guide).toContain(`> **Schema:** [\`${file}`);
    // The sections ADR-0226 §3.3 requires.
    for (const heading of [
      '## Tier 1: a design system you own',
      '## Tier 2: a design system you do not own',
      '## Tier 3: rooms',
      '## `oui.config.json`',
      '## `generate --check` in CI',
      '## Work that outlives the call: the job effect',
      '### A job tracker from the product\'s declared events',
      '## Irreversible actions: the approval card',
      '## The conformance kit',
    ]) {
      expect(guide).toContain(heading);
    }
    expect(() => renderGuide(onDisk, { 'x.md': '<!-- schema: nope.json -->' })).toThrow(/names schemas\/nope\.json/);
  });

  it('lists every schema file, and every listed file exists', () => {
    expect(Object.keys(onDisk).sort()).toEqual(CONTRACT_FILES.map((f) => f.file).sort());
    expect(Object.keys(CONTRACT_SCHEMAS).sort()).toEqual(Object.keys(onDisk).sort());
  });

  it('versions every contract schema with MANIFEST_VERSION, under a path with no npm scope in it', () => {
    expect(MANIFEST_VERSION).toBe(1);
    expect(CONTRACT_SCHEMA_BASE).toBe('https://schemas.closurestudio.ai/oui/v1/');
    for (const { file } of CONTRACT_FILES) {
      const id = CONTRACT_SCHEMAS[file as keyof typeof CONTRACT_SCHEMAS].$id;
      expect(id).not.toMatch(/@|closurestudio\//);
      if (file !== 'event-declarations.json') expect(id).toBe(`${CONTRACT_SCHEMA_BASE}${file}`);
    }
    // The event declarations keep W9's own document version and $id.
    expect(CONTRACT_SCHEMAS['event-declarations.json'].$id).toBe(
      'https://schemas.closurestudio.ai/agent-sdk/event-declarations/v1.json',
    );
    const manifest = CONTRACT_SCHEMAS['oui-manifest.json'] as unknown as { properties: { version: { const: number } } };
    const knowledge = CONTRACT_SCHEMAS['generated-knowledge.json'] as unknown as { properties: { version: { const: number } } };
    expect(manifest.properties.version.const).toBe(MANIFEST_VERSION);
    expect(knowledge.properties.version.const).toBe(MANIFEST_VERSION);
  });

  it('refuses a schema whose $id does not carry the major', () => {
    const wrong = { ...onDisk, 'agent-binding.json': { ...onDisk['agent-binding.json'], $id: `${CONTRACT_SCHEMA_BASE.replace('v1', 'v2')}agent-binding.json` } };
    expect(() => renderContract(wrong, '')).toThrow(/agent-binding\.json: \$id must be/);
  });

  it('compiles every schema under a strict 2020-12 validator (strictRequired off: an if/then names a property declared beside it)', () => {
    const ajv = new Ajv2020({ strict: true, strictRequired: false });
    for (const schema of Object.values(CONTRACT_SCHEMAS)) ajv.addSchema(schema as object);
    for (const schema of Object.values(CONTRACT_SCHEMAS)) expect(() => ajv.getSchema(schema.$id)).not.toThrow();
  });

  it('keeps the SchemaProps keys in step wherever a schema lists them', () => {
    const kinds = CONTRACT_SCHEMAS['control-kind-registration.json'] as unknown as {
      $defs: { SchemaProps: { properties: Record<string, unknown> }; SchemaPropName: { enum: string[] } };
    };
    const table = CONTRACT_SCHEMAS['control-table.json'] as unknown as {
      $defs: { SchemaPropSources: { properties: Record<string, unknown> } };
    };
    const keys = Object.keys(kinds.$defs.SchemaProps.properties).sort();
    expect([...kinds.$defs.SchemaPropName.enum].sort()).toEqual(keys);
    expect(Object.keys(table.$defs.SchemaPropSources.properties).sort()).toEqual(keys.filter((k) => k !== 'options'));
  });

  it('names a schema for every generated type', () => {
    for (const name of Object.keys(CONTRACT_TYPES)) expect(() => contractSchemaId(name as keyof typeof CONTRACT_TYPES)).not.toThrow();
    expect(contractSchemaId('ControlDescriptor')).toBe(`${CONTRACT_SCHEMA_BASE}control-table.json#/$defs/ControlDescriptor`);
    expect(() => contractSchemaId('NoSuchThing' as never)).toThrow(/not a schema or type/);
  });
});

describe('each schema accepts what ADR-0226 specifies', () => {
  it('oui.config.json: the ADR §2.4 example, without the tier 2 mappings W4 adds', () => {
    const config: OuiConfigFile = {
      tsconfig: 'tsconfig.json',
      routes: 'src/routes.tsx',
      routeWrappers: ['Suspense', 'ErrorBoundary'],
      nav: ['src/nav.ts'],
      shell: [{ module: 'src/app/AppFrame.tsx', export: 'AppFrame' }],
      designSystem: ['@traidr/ui'],
      apiSpec: '@traidr/api-client/openapi.json',
      appCatalogs: [{ module: 'src/studio/catalog.ts', export: 'strategyCanvasCatalog', hosts: ['StrategyCanvas'] }],
      unbound: [],
      out: 'src/agent/generated',
    };
    expect(contractProblems('oui-config.json', config)).toEqual([]);
    expect(contractProblems('oui-config.json', { ...config, apiSpec: null, designSystem: [] })).toEqual([]);
  });

  it('oui.config.json: no defaults, nothing unknown', () => {
    const { apiSpec: _, ...noSpec } = { tsconfig: 't', routes: 'r', out: 'o', designSystem: [], apiSpec: null };
    expect(contractProblems('oui-config.json', noSpec)).toEqual([expect.stringContaining("must have required property 'apiSpec'")]);
    expect(contractProblems('oui-config.json', { tsconfig: 't', routes: 'r', out: 'o', designSystem: [], apiSpec: null, apiClient: 'x' })).toEqual([
      '/ has "apiClient", which the contract does not define',
    ]);
    expect(contractProblems('oui-config.json', { tsconfig: ' ', routes: 'r', out: 'o', designSystem: [], apiSpec: null })).not.toEqual([]);
  });

  it('Tier2Mapping: the ADR §2.3 Mantine example, and a Radix compound part', () => {
    const mantine: Tier2Mapping = {
      package: '@mantine/core',
      controls: {
        Button: { kind: 'button', callbacks: ['onClick'], titleProps: ['aria-label', 'children'] },
        Select: {
          kind: 'choice',
          callbacks: ['onChange'],
          valueFrom: { arg: 0 },
          controlled: 'value',
          options: { prop: 'data', value: 'value', title: 'label' },
          titleProps: ['label', 'placeholder'],
        },
        MultiSelect: {
          kind: 'multi-choice',
          callbacks: ['onChange'],
          valueFrom: { arg: 0 },
          controlled: 'value',
          options: { prop: 'data', value: 'value', title: 'label' },
        },
      },
    };
    expect(contractProblems('tier2-mapping.json', mantine)).toEqual([]);
    const radix: Tier2Mapping = {
      package: '@radix-ui/react-select',
      controls: {
        Select: {
          kind: 'choice',
          callbacks: ['onValueChange'],
          valueFrom: { arg: 0 },
          controlled: 'value',
          parts: { root: { export: 'Root' }, item: { export: 'Item', valueProp: 'value', titleProps: ['children'] } },
        },
      },
    };
    expect(contractProblems('tier2-mapping.json', radix)).toEqual([]);
    const mui = { package: '@mui/material', controls: { TextField: { kind: 'text', callbacks: ['onChange'], valueFrom: { arg: 0, path: 'target.value' }, controlled: 'value' } } };
    expect(contractProblems('tier2-mapping.json', mui)).toEqual([]);
  });

  it('Tier2Mapping: a value control must say where its value is and which prop shows it', () => {
    const problems = contractProblems('tier2-mapping.json', {
      package: '@mantine/core',
      controls: { Select: { kind: 'choice', callbacks: ['onChange'] } },
    });
    expect(problems.join('\n')).toMatch(/valueFrom/);
    expect(problems.join('\n')).toMatch(/controlled/);
    expect(
      contractProblems('tier2-mapping.json', {
        package: 'x',
        controls: { S: { kind: 'choice', callbacks: ['onChange'], valueFrom: { arg: 0 }, controlled: 'value', options: { prop: 'data', value: 'v', title: 't' }, parts: { root: { export: 'Root' }, item: { export: 'Item' } } } },
      }),
    ).not.toEqual([]);
  });

  it('AgentBinding: dotted lower-kebab ids, a description, and a valid effect', () => {
    expect(contractProblems('AgentBinding', { id: 'orders.place', description: 'Places the order', effect: { kind: 'transaction', operation: 'placeOrder', approvalMinutes: 10 } })).toEqual([]);
    expect(contractProblems('AgentBinding', { id: 'Orders', description: 'x' })).not.toEqual([]);
    expect(contractProblems('AgentBinding', { id: 'orders.place' })).not.toEqual([]);
    expect(contractProblems('AgentBinding', { id: 'orders.place', description: 'x', effect: { kind: 'transaction', approvalMinutes: 31 } })).not.toEqual([]);
    expect(contractProblems('AgentBinding', { id: 'orders.place', description: 'x', effect: 'destroy' })).not.toEqual([]);
    expect(contractProblems('AgentProp', { nonAgent: 'decorative' })).toEqual([]);
    expect(contractProblems('AgentProp', { nonAgent: '' })).not.toEqual([]);
  });

  it('ControlKindRegistration: only x- kinds, with a verb and a schema', () => {
    const range = {
      kind: 'x-price-range',
      verb: 'Set the price range of',
      deriveSchema: { schema: { type: 'object', properties: { low: { type: 'number' } } }, props: { '/properties/low/minimum': 'min' } },
    };
    expect(contractProblems('ControlKindRegistration', range)).toEqual([]);
    expect(contractProblems('ControlKindRegistration', { ...range, kind: 'range' })).not.toEqual([]);
    expect(contractProblems('ControlKindRegistration', { ...range, deriveSchema: { schema: {}, props: { low: 'min' } } })).not.toEqual([]);
    expect(contractProblems('ControlKindRegistration', { ...range, deriveSchema: { schema: {}, props: { '/x': 'colour' } } })).not.toEqual([]);
  });

  it('ControlTableFile: descriptors by export name, and the kinds it registers', () => {
    const table = {
      $kinds: [{ kind: 'x-ink', verb: 'Set the ink of', deriveSchema: { schema: { type: 'string' } } }],
      Button: { kind: 'button', callbacks: ['onClick'], titleProps: ['children'] },
      Swatch: { kind: 'x-ink', callbacks: ['onChange'], titleProps: [] },
      Card: { callbacks: [], slots: { open: { kind: 'button', callback: 'onClick', rows: true } }, titleProps: ['title'] },
    };
    expect(contractProblems('control-table.json', table)).toEqual([]);
    expect(contractProblems('control-table.json', { Button: { kind: 'press', callbacks: [], titleProps: [] } })).not.toEqual([]);
    expect(contractProblems('control-table.json', { button: { kind: 'button', callbacks: [], titleProps: [] } })).not.toEqual([]);
    expect(contractProblems('control-table.json', { Button: { kind: 'button', callbacks: [], titleProps: [], label: 'x' } })).toEqual([
      '/Button has "label", which the contract does not define',
    ]);
  });

  it('RoomCatalogData: a catalog without animation, and one that declares its own recipe', () => {
    const catalog = {
      room: 'strategy-canvas',
      title: 'Strategy canvas',
      description: 'Where a strategy is drawn.',
      actions: [
        {
          kind: 'action',
          id: 'place-order',
          title: 'Place order',
          description: 'Places the order the strategy describes.',
          control: 'The Place order button',
          input: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
          effect: { kind: 'transaction', operation: 'placeOrder' },
        },
      ],
      fields: [
        {
          kind: 'field',
          id: 'risk',
          title: 'Risk',
          description: 'How much of the account a trade may risk.',
          control: 'The Risk field',
          section: { id: 'limits', title: 'Limits' },
          appliesTo: ['strategy'],
          value: { type: 'number', minimum: 0, maximum: 100, 'x-unit': '%' },
        },
      ],
      commands: [],
      observations: [{ id: 'problems', description: 'What is wrong', schema: { type: 'array' } }],
      problems: [{ kind: 'order-rejected', description: 'The broker refused the order' }],
      recipes: [{ name: 'Trade a signal', trigger: 'When asked to act on a signal', steps: ['{action:place-order}'] }],
    };
    expect(contractProblems('room-catalog-data.json', catalog)).toEqual([]);
    const typo = { ...catalog, fields: [{ ...catalog.fields[0], keyframable: true }] };
    expect(contractProblems('room-catalog-data.json', typo).join('\n')).toMatch(/keyframable/);
  });

  it('JobSettlement: the job states, and only those', () => {
    for (const settled of [
      { status: 'started', jobId: 'j1' },
      { status: 'running', jobId: 'j1' },
      { status: 'complete', jobId: 'j1', url: 'https://x' },
      { status: 'failed', jobId: 'j1', error: 'GPU lost' },
      { status: 'unverified', message: 'No job id to follow' },
    ]) {
      expect(contractProblems('JobSettlement', settled)).toEqual([]);
    }
    expect(contractProblems('JobSettlement', { status: 'done', jobId: 'j1' })).not.toEqual([]);
    expect(contractProblems('JobOutcome', { status: 'failed', jobId: 'j1' })).not.toEqual([]);
  });

  it('Approvals: the card, the decision, the token and the request a tab checks', () => {
    const hash = 'a'.repeat(64);
    const preview = { title: 'Place order', arguments: [{ name: 'symbol', label: 'Symbol', value: 'AAPL' }], readback: 'Place order: Symbol AAPL.' };
    expect(
      contractProblems('ApprovalRequiredEvent', {
        turnId: 't', conversationId: 'c', approvalId: 'a', tool: 'orders_place', effect: 'transaction', destructive: false, preview, expiresAt: 1, timestamp: 1,
      }),
    ).toEqual([]);
    expect(contractProblems('ApprovalDecidePayload', { approvalId: 'a', decision: 'approve' })).toEqual([]);
    expect(contractProblems('ApprovalDecidePayload', { approvalId: 'a', decision: 'yes' })).not.toEqual([]);
    expect(contractProblems('ApprovalDecideResult', { ok: true, decision: 'approve', approvalId: 'a', token: 'jws', argsHash: hash, expiresAt: 1, channel: 'ui' })).toEqual([]);
    expect(contractProblems('ApprovalDecideResult', { ok: false, reason: 'used', error: 'Already redeemed' })).toEqual([]);
    expect(contractProblems('ActionRequestApproval', { approvalId: 'a', argsHash: hash })).toEqual([]);
    expect(contractProblems('ActionRequestApproval', { approvalId: 'a', argsHash: 'ABC' })).not.toEqual([]);
    expect(contractProblems('ApprovalTokenClaims', { aid: 'a', sub: 'u', cid: 'c', tool: 't', ah: hash, eff: 'transaction', ch: 'voice', iat: 1, exp: 2, jti: 'n' })).toEqual([]);
  });

  it('Event declarations: a document with one job kind', () => {
    const doc = {
      version: 1,
      product: 'fixture',
      rooms: { job: { pattern: 'job:{jobId}' } },
      events: {
        'report:ready': {
          description: 'A report is ready',
          payload: { type: 'object', properties: { jobId: { type: 'string' }, url: { type: 'string' } }, required: ['jobId'] },
          rooms: ['job'],
          correlation: ['jobId'],
          role: 'completion',
          completes: 'report',
          result: ['url'],
        },
      },
    };
    expect(contractProblems('event-declarations.json', doc)).toEqual([]);
    const { completes: _, ...noKind } = doc.events['report:ready'];
    expect(contractProblems('event-declarations.json', { ...doc, events: { 'report:ready': noKind } })).not.toEqual([]);
  });

  it('a validator throws naming what it checked', () => {
    expect(() => createContractValidator().assert('AgentBinding', { id: 'x' }, 'the Save button’s binding')).toThrow(
      /the Save button’s binding does not match the OUI contract's AgentBinding/,
    );
  });
});
