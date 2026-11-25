/**
 * A turn's share of input read from the prompt cache (`usage.cachedShare`) is
 * held only on a model that reads one. In a matrix whose candidates include
 * models with no prompt cache, a turn of many calls declares the share it
 * measured, which `--estimate` prices as cache reads where there is a cache,
 * and a model with none was failed for not reading a cache it does not have.
 */
import { describe, expect, it } from 'vitest';
import { check, type EvalTurnRecord } from '../run.js';

const turn = (cachedShare: number): EvalTurnRecord =>
  ({
    turn: 0,
    kind: 'user',
    customer: 'build it',
    reply: 'Built.',
    working: '',
    toolCalls: [],
    approval: null,
    held: false,
    modelRequests: 3,
    usage: {
      calls: [{ inputTokens: 10_000 }, { inputTokens: 11_000 }, { inputTokens: 12_000 }],
      firstCallInputTokens: 10_000,
      inputTokens: 33_000,
      outputTokens: 900,
      cacheReadTokens: Math.round(33_000 * cachedShare),
      cachedShare,
    },
    choices: [],
    page: null,
    invalidToolCalls: [],
  }) as unknown as EvalTurnRecord;

const expectation = { usage: { cachedShare: { min: 0.85 } } };
const assertions = async (record: EvalTurnRecord, promptCache?: boolean) =>
  (await check(expectation, record, '', null, promptCache === undefined ? {} : { promptCache })).map((f) => f.assertion);

describe('usage.cachedShare', () => {
  it('holds on a model that reads a prompt cache, and where that is not known', async () => {
    expect(await assertions(turn(0.6), true)).toEqual(['usage.cachedShare']);
    expect(await assertions(turn(0.6))).toEqual(['usage.cachedShare']);
    expect(await assertions(turn(0.92), true)).toEqual([]);
  });

  it('is not held on a model with no prompt cache', async () => {
    expect(await assertions(turn(0), false)).toEqual([]);
  });
});
