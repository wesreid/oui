/**
 * A product outside this repository, with the packages installed from a
 * registry or from their tarballs: every entry point loads, the contract
 * validates, the generator's command runs under both names, and the app has
 * one copy of each package.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const ENTRIES: Record<string, string[]> = {
  'oui-spec': ['createOUI', 'defineSurface', 'createSurfaceRuntime', 'argsHash', 'requiresApproval'],
  'oui-spec/spec': ['OUI_EFFECT_KINDS'],
  'oui-spec/core': ['defineSurface', 'createSurfaceRuntime'],
  'oui-spec/transport': ['createWebSocketTransport'],
  '@ouispec/contract': ['MANIFEST_VERSION', 'CONTRACT_SCHEMAS', 'CONTRACT_FILES'],
  '@ouispec/contract/validate': ['contractProblems', 'createContractValidator'],
  '@ouispec/contract/codegen': [],
  '@ouispec/bindings': ['MANIFEST_VERSION', 'createBindingRegistry', 'effectKind', 'requiresApproval', 'resolveKnowledge'],
  '@ouispec/bindings/react': ['AgentBindingProvider', 'useAgentBinding', 'useRoomRegistration'],
  '@ouispec/bindings/oui': ['connectBindings', 'createDeclaredJobTracker'],
  '@ouispec/cli': ['generate', 'loadConfig'],
  '@ouispec/testing': ['checkDesignSystem', 'checkApp', 'checkTier2', 'readShippedPackage'],
  '@ouispec/agent-core': ['AGENT_SOCKET_EVENTS', 'APPROVAL_DECIDE_EVENT'],
  '@ouispec/agent-events': ['createEventCatalog', 'PLATFORM_EVENTS', 'AGENT_TURN_EVENTS'],
  '@ouispec/agent-events/validate': [],
  '@ouispec/agent-events/codegen': [],
  '@ouispec/agent-worker': ['createLambdaAgentHandler', 'startContainerAgentWorker', 'PROMPT_CACHE_BREAKPOINTS'],
  '@ouispec/agent-worker/lambda': ['createLambdaAgentHandler'],
  '@ouispec/agent-worker/container': ['startContainerAgentWorker'],
  '@ouispec/agent-worker/testing': ['recordingFetch', 'replayingFetch', 'scriptedChatCompletions'],
  '@ouispec/agent-realtime': ['createRealtimeServer'],
  '@ouispec/agent-realtime/testing': ['startTestRedis'],
  '@ouispec/agent-react': ['AgentProvider', 'useAgent', 'ApprovalCard'],
  '@ouispec/agent-mcp': ['createMCPApiToolServer', 'handleMCPRequest'],
  '@ouispec/agent-evals': ['defineEvals', 'evalCases', 'runEvals'],
};

describe('the installed packages', () => {
  it.each(Object.entries(ENTRIES))('%s loads and exports what a product uses', async (entry, names) => {
    const loaded = (await import(entry)) as Record<string, unknown>;
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
    for (const name of names) expect(loaded[name], `${entry} exports ${name}`).toBeDefined();
  });

  it('agree on one contract: bindings carries the contract\'s manifest version', async () => {
    const contract = await import('@ouispec/contract');
    const bindings = await import('@ouispec/bindings');
    expect(bindings.MANIFEST_VERSION).toBe(contract.MANIFEST_VERSION);
    expect(contract.MANIFEST_VERSION).toBe(1);
  });

  it('the contract accepts a valid tier 2 mapping and says what is wrong with an invalid one', async () => {
    const { contractProblems } = await import('@ouispec/contract/validate');
    const mapping = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/tier2-mapping.json'), 'utf8'));
    expect(contractProblems('tier2-mapping.json', mapping)).toEqual([]);
    const broken = { ...mapping, controls: { ThirdButton: { kind: 'not-a-kind', callbacks: ['onClick'] } } };
    expect(contractProblems('tier2-mapping.json', broken).length).toBeGreaterThan(0);
    expect(contractProblems('oui-manifest.json', {}).length).toBeGreaterThan(0);
  });

  it('the schemas ship as files, with the manifest version in their ids', () => {
    const dir = join(ROOT, 'node_modules/@ouispec/contract/schemas');
    const files = readdirSync(dir).filter(name => name.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(12);
    const manifest = JSON.parse(readFileSync(join(dir, 'oui-manifest.json'), 'utf8'));
    expect(manifest.$id).toMatch(/\/oui\/v1\/oui-manifest\.json$/);
  });

  it('the platform\'s own events make a catalog', async () => {
    const { createEventCatalog, PLATFORM_EVENTS, AGENT_TURN_EVENTS } = await import('@ouispec/agent-events');
    const catalog = createEventCatalog(PLATFORM_EVENTS);
    expect(catalog.names().length).toBeGreaterThan(0);
    expect(catalog.has(AGENT_TURN_EVENTS.TOKEN)).toBe(true);
    expect(catalog.has('not:declared')).toBe(false);
  });

  it('the eval harness replays its dealer example from the installed package, on every channel, with no network or credentials', () => {
    const bin = join(ROOT, 'node_modules/.bin/agent-evals');
    expect(existsSync(bin)).toBe(true);
    const config = join(ROOT, 'node_modules/@ouispec/agent-evals/examples/dealer/agent-evals.config.mjs');
    const run = spawnSync(bin, ['--config', config], { encoding: 'utf8', env: { ...process.env, AWS_PROFILE: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim().split('\n').at(-1)).toBe('21 passed, 0 failed, of 21 (from the recordings)');
  });

  it.each(['oui', 'closure-oui'])('the generator runs as %s', name => {
    const bin = join(ROOT, 'node_modules/.bin', name);
    expect(existsSync(bin)).toBe(true);
    const usage = spawnSync(bin, [], { encoding: 'utf8' });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain(`usage: ${name} generate`);
    // With no oui.config.json it names the missing file rather than guessing one.
    const missing = spawnSync(bin, ['generate', '--check'], { encoding: 'utf8', cwd: join(ROOT, 'test') });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('oui.config.json');
  });

  it('there is one copy of each package', () => {
    const tree = JSON.parse(execFileSync('npm', ['ls', '--all', '--json'], { cwd: ROOT, encoding: 'utf8' })) as Tree;
    const versions = new Map<string, Set<string>>();
    const visit = (node: Tree) => {
      for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
        if (name === 'oui-spec' || name.startsWith('@ouispec/')) {
          versions.set(name, (versions.get(name) ?? new Set()).add(dep.version));
        }
        visit(dep);
      }
    };
    visit(tree);
    expect([...versions.keys()].sort()).toEqual(
      ['oui-spec', ...['contract', 'bindings', 'cli', 'testing', 'agent-core', 'agent-events', 'agent-worker', 'agent-realtime', 'agent-react', 'agent-mcp', 'agent-evals'].map(n => `@ouispec/${n}`)].sort(),
    );
    for (const [name, set] of versions) expect([...set], `${name} versions installed`).toHaveLength(1);
  });
});

interface Tree {
  version: string;
  dependencies?: Record<string, Tree>;
}
