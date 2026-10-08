/**
 * The dealer example (ADR-0260 §3.8, acceptance 8): a dealer agent's first
 * acceptance cases, recorded from Claude on Bedrock, replayed on web chat, SMS
 * and voice with no network and no credentials; and the CLI a product runs in
 * its CI, with its exit codes and reports.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runEvals } from '../run.js';
import type { AgentEvalConfig } from '../config.js';
import { scratch } from './support.js';

const PKG = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLE = join(PKG, 'examples/dealer/agent-evals.config.mjs');
const CLI = join(PKG, 'dist/cli.js');
const tmp = scratch();
afterAll(() => tmp.cleanup());

describe('the dealer example', () => {
  it('passes every acceptance case on every channel, from its recordings', async () => {
    const { default: config } = (await import(pathToFileURL(EXAMPLE).href)) as { default: AgentEvalConfig };
    const report = await runEvals(config);
    expect(report.cases.map((c) => [c.scenario, c.channel, c.failures])).toEqual(
      [
        'ai-disclosure',
        'price-only',
        'injected-instruction',
        'ssn-refused',
        'hand-off',
        'service-booking-readback',
        'takeover-and-hand-back',
      ].flatMap((id) => ['web_chat', 'sms', 'voice'].map((channel) => [id, channel, []])),
    );
    const byCase = new Map(report.cases.map((c) => [`${c.scenario} [${c.channel}]`, c]));
    // On SMS and voice the readback is the reply, word for word; on web chat it is the card's.
    const readback = 'Book a service visit: Service Oil change, Day Saturday, Time 9:00 AM.';
    expect(byCase.get('service-booking-readback [sms]')!.turns[0].reply).toContain(readback);
    expect(byCase.get('service-booking-readback [voice]')!.turns[0].reply).toContain(readback);
    expect(byCase.get('service-booking-readback [web_chat]')!.turns[0].reply).not.toContain(readback);
    // While Jordan held the conversation the agent made no call; after, it kept Jordan's price.
    for (const channel of ['web_chat', 'sms', 'voice']) {
      const takeover = byCase.get(`takeover-and-hand-back [${channel}]`)!;
      expect(takeover.turns.find((t) => t.held)).toMatchObject({ modelRequests: 0, reply: '' });
      expect(takeover.turns.at(-1)!.reply).toContain('31,495');
    }
  });
});

describe('the agent-evals CLI', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: PKG, encoding: 'utf8' });

  it('replays the example, says what passed, writes JUnit and JSON, and exits 0', () => {
    const junit = join(tmp.dir, 'evals.xml');
    const json = join(tmp.dir, 'evals.json');
    const out = run('--config', EXAMPLE, '--channel', 'sms', '--scenario', 'price-only', '--scenario', 'ssn-refused', '--junit', junit, '--json', json);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('PASS  dealer › price-only [sms]');
    expect(out.stdout.trim().split('\n').at(-1)).toBe('2 passed, 0 failed, of 2 (from the recordings)');
    // The worker's own turn logs stay out of the report.
    expect(out.stdout).not.toContain('"level"');
    expect(readFileSync(junit, 'utf8')).toContain('<testsuite name="dealer" tests="2" failures="0"');
    expect((JSON.parse(readFileSync(json, 'utf8')) as { passed: number }).passed).toBe(2);
  });

  it('exits 1 when the configuration changed since the recordings were made, saying to record them again', () => {
    const changed = join(tmp.dir, 'changed.config.mjs');
    writeFileSync(
      changed,
      [
        `import base from ${JSON.stringify(pathToFileURL(EXAMPLE).href)};`,
        `export default {`,
        `  ...base,`,
        `  root: ${JSON.stringify(join(PKG, 'examples/dealer'))},`,
        `  agent: (ctx) => { const agent = base.agent(ctx); return { ...agent, persona: { ...agent.persona, instructions: [...agent.persona.instructions, 'Be brief.'] } }; },`,
        `};`,
      ].join('\n'),
    );
    const out = run('--config', changed, '--channel', 'web_chat', '--scenario', 'ai-disclosure');
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('FAIL  dealer › ai-disclosure [web_chat]');
    expect(out.stdout).toContain('recording: ');
    expect(out.stdout).toContain('record it again with `agent-evals --record`');
  });

  it('exits 2, with its usage, when it cannot run', () => {
    expect(run('--config', join(tmp.dir, 'missing.config.mjs')).status).toBe(2);
    const bad = run('--record', '--live');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--record and --live cannot be given together');
    expect(bad.stderr).toContain('usage: agent-evals');
    expect(run('--channel', 'fax', '--config', EXAMPLE).stderr).toContain('no channel "fax" in the configuration');
    expect(execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toBe('');
  });
});
