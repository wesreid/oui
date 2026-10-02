/**
 * The UI order's places (ui-sequence.ts): a place is taken when it is reserved,
 * not when its action is ready; a place given up lets the next one run; and a
 * place whose action is running stays held until that action settles.
 */
import { describe, it, expect } from 'vitest';
import { createUISequence } from '../ui/ui-sequence.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a UI sequence place', () => {
  it('holds the order it was reserved in, whichever action is ready first', async () => {
    const sequence = createUISequence();
    const ran: string[] = [];
    const first = sequence.reserve();
    const second = sequence.reserve();

    // The second is ready first.
    const b = second.run(async () => {
      ran.push('second');
    });
    await sleep(10);
    expect(ran).toEqual([]);
    const a = first.run(async () => {
      ran.push('first');
    });
    await Promise.all([a, b]);
    expect(ran).toEqual(['first', 'second']);
  });

  it('given up without running, lets the next place run', async () => {
    const sequence = createUISequence();
    const refused = sequence.reserve();
    const next = sequence.reserve();
    const ran = next.run(async () => 'ran');
    refused.release();
    await expect(ran).resolves.toBe('ran');
  });

  it('once running, is not freed by a release: the next waits for the action to settle', async () => {
    const sequence = createUISequence();
    const events: string[] = [];
    const slow = sequence.reserve();
    const running = slow.run(async () => {
      await sleep(30);
      events.push('slow settled');
    });
    // The caller stops waiting (a timeout) and releases.
    slow.release();
    await sequence.run(async () => {
      events.push('next ran');
    });
    await running;
    expect(events).toEqual(['slow settled', 'next ran']);
  });

  it('lets the next place run after a failed action', async () => {
    const sequence = createUISequence();
    const failed = sequence.run(async () => {
      throw new Error('page refused');
    });
    await expect(failed).rejects.toThrow('page refused');
    await expect(sequence.run(async () => 'next')).resolves.toBe('next');
  });

  it('runs one action per place', async () => {
    const slot = createUISequence().reserve();
    await slot.run(async () => undefined);
    expect(() => slot.run(async () => undefined)).toThrow(/one action/);
  });
});
