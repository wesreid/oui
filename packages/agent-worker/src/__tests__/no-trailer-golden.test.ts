/**
 * A host that declares no trailer tool gets byte for byte what it got before
 * the note trailer existed (agent-worker 0.41.1): the same request bodies to
 * the provider, the same events to the person, the same stored messages and
 * the same report of the turn.
 *
 * The captures in `fixtures/no-trailer-golden/` were taken from 0.41.1 (origin
 * main at eab59d0b), before any of the trailer's code: the answerless tools'
 * scenarios (`answerless-tools.e2e.test.ts`), a spoken turn, and the Bedrock
 * fixture turn (`fixture-turn.e2e.test.ts`, its recorded responses). Only what
 * changes from run to run is taken out (`withoutClock`): timestamps, durations
 * and the clock line's date, time and offset.
 *
 * `GOLDEN_WRITE=1` writes them again. Never do that to make a change pass: a
 * difference is a change to what a host that did not opt in gets.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TurnStopRecord } from '@ouispec/agent-core';
import { startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { runFixtureTurn } from './support/fixture-turn.js';
import { bedrockReplay } from './support/replay.js';
import {
  AFTER_NOTE,
  asHistory,
  BRIGHTEN_CALL,
  brightenTool,
  NOTE_CALL,
  noteTool,
  noteTurn,
  REPLY,
  scriptedOpenAIModel,
  withoutClock,
  type Emitted,
  type NoteTurnRun,
} from './support/note-turn.js';
import type { ScriptedReply } from '../testing/scripted.js';
import type { RegisteredTool } from '../tools/types.js';
import type { TurnHistoryMessage } from '../types.js';

const DIR = fileURLToPath(new URL('./fixtures/no-trailer-golden/', import.meta.url));
const WRITE = process.env.GOLDEN_WRITE === '1';

/** What a run is compared by: everything a host or the person can see of it. */
function captured(run: { requests: unknown[]; events: Emitted[]; stored: unknown; recorded?: unknown; outcome: unknown }) {
  return withoutClock({ requests: run.requests, events: run.events, stored: run.stored, recorded: run.recorded ?? null, outcome: run.outcome });
}

/** The run, against its capture: byte for byte. */
function matchesGolden(name: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = `${DIR}${name}.json`;
  if (WRITE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(text).toBe(readFileSync(path, 'utf8'));
}

async function scripted(tools: RegisteredTool[], replies: ScriptedReply[], extra: Partial<Parameters<typeof noteTurn>[0]> = {}): Promise<NoteTurnRun> {
  return noteTurn({ tools, provider: scriptedOpenAIModel(replies), ...extra });
}

const SECOND_NOTE = { id: 'call_note_2', name: 'note', args: { kind: 'task', text: 'Master the track.' } };
const BAD_NOTE = { id: 'call_note', name: 'note', args: { kind: 'decision', text: 'x', colour: 'red' } };

describe('a host with no trailer tool: what it gets is what 0.41.1 gave it', () => {
  it('reply + answerless note: one call', async () => {
    matchesGolden('answerless-acceptance', captured(await scripted([noteTool({ answerless: true })], [{ text: REPLY, toolCalls: [NOTE_CALL] }])));
  });

  it('the next turn reads the stored conversation', async () => {
    const first = await scripted([noteTool({ answerless: true })], [{ text: REPLY, toolCalls: [NOTE_CALL] }]);
    const history: TurnHistoryMessage[] = [{ role: 'user', content: 'Brighten the chorus.' }, ...asHistory(first.stored)];
    matchesGolden(
      'answerless-next-turn',
      captured(await scripted([noteTool({ answerless: true })], [{ text: 'The verse is as it was.' }], { history, turnId: 'turn-note-2' })),
    );
  });

  it('a note tool that is not answerless: two calls', async () => {
    matchesGolden(
      'plain-note',
      captured(await scripted([noteTool({ answerless: false })], [{ text: REPLY, toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }])),
    );
  });

  it('several answerless calls', async () => {
    matchesGolden('answerless-several', captured(await scripted([noteTool({ answerless: true })], [{ text: REPLY, toolCalls: [NOTE_CALL, SECOND_NOTE] }])));
  });

  it('no reply text', async () => {
    matchesGolden('answerless-no-text', captured(await scripted([noteTool({ answerless: true })], [{ toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }])));
  });

  it('only whitespace', async () => {
    matchesGolden(
      'answerless-whitespace',
      captured(await scripted([noteTool({ answerless: true })], [{ text: '  \n', toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }])),
    );
  });

  it('a failed answerless call', async () => {
    matchesGolden(
      'answerless-failed',
      captured(await scripted([noteTool({ answerless: true, fails: true })], [{ text: REPLY, toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }])),
    );
  });

  it('another tool in the same step', async () => {
    matchesGolden(
      'answerless-with-another-tool',
      captured(
        await scripted([noteTool({ answerless: true }), brightenTool], [{ text: REPLY, toolCalls: [BRIGHTEN_CALL, NOTE_CALL] }, { text: AFTER_NOTE }]),
      ),
    );
  });

  it('input that is not the schema', async () => {
    matchesGolden('answerless-invalid', captured(await scripted([noteTool({ answerless: true })], [{ text: REPLY, toolCalls: [BAD_NOTE] }, { text: AFTER_NOTE }])));
  });

  it('work, then reply + note', async () => {
    matchesGolden(
      'answerless-work-then-reply',
      captured(
        await scripted(
          [noteTool({ answerless: true }), brightenTool],
          [{ toolCalls: [BRIGHTEN_CALL] }, { text: REPLY, toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }],
        ),
      ),
    );
  });

  it('a spoken turn', async () => {
    matchesGolden(
      'answerless-spoken',
      captured(
        await scripted([noteTool({ answerless: true })], [{ text: REPLY, toolCalls: [NOTE_CALL] }], {
          context: { currentPath: '/music/generate', timeZone: 'Europe/Paris', output: { mode: 'voice' } },
        }),
      ),
    );
  });

  it('stopped while the answerless call runs', async () => {
    let hear: ((record: TurnStopRecord) => void) | null = null;
    const note = noteTool({
      answerless: true,
      whileRunning: async () => {
        hear?.({ turnId: 'turn-note-1', by: 'user-1', reason: 'user_stop', at: 1_790_700_000_000 });
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    const run = await scripted([note], [{ text: REPLY, toolCalls: [NOTE_CALL] }], { stop: { fire: (h) => (hear = h) } });
    matchesGolden('answerless-stopped', captured(run));
  });
});

describe('the Bedrock fixture turn, with no trailer tool', () => {
  let product: FixtureProduct;
  beforeAll(async () => {
    product = await startFixtureProduct();
  }, 20_000);
  afterAll(async () => {
    await product?.stop();
  });

  it('sends, emits and stores what 0.41.1 did', async () => {
    const provider = bedrockReplay();
    const events: Emitted[] = [];
    const run = await runFixtureTurn(product, {
      adapter: 'lambda',
      model: provider.model,
      promptCacheBreakpoint: provider.promptCacheBreakpoint,
      turnId: 'turn-fx-golden',
      onEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
    });
    matchesGolden('bedrock-fixture-turn', withoutClock({ requests: provider.requests, events, stored: run.persisted, outcome: run.outcome }));
  }, 30_000);
});
