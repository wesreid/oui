/**
 * The turn's record of its own calls (ADR-0244 §2.5): nothing while every
 * call succeeds, and once one has not, a note for every later step that names
 * it with its reason and holds the reply to it.
 */
import { describe, expect, it } from 'vitest';

import { createTurnLedger, ledgerNote } from '../turn-ledger.js';

describe('the turn ledger', () => {
  it('says nothing while every call has succeeded', () => {
    const ledger = createTurnLedger();
    ledger.record({ tool: 'vector_studio_add_text', ok: true });
    ledger.record({ tool: 'vector_studio_align', ok: true });
    expect(ledger.note()).toBeNull();
    expect(ledger.entries()).toHaveLength(2);
  });

  it('names each call that did not succeed, with why, among how many were made', () => {
    const ledger = createTurnLedger();
    ledger.record({ tool: 'vector_studio_add_artboard', ok: true });
    ledger.record({
      tool: 'vector_studio_select',
      ok: false,
      error: 'No layer or artboard with id "Anim 01" — read the room’s document observation for ids',
    });
    ledger.record({ tool: 'vector_studio_align', ok: true });
    ledger.record({ tool: 'vector_studio_remove_keyframe', ok: false, error: 'Not run: this turn is waiting for the user’s approval' });
    const note = ledger.note()!;
    expect(note).toContain('This turn has made 4 calls; 2 did not succeed:');
    expect(note).toContain('- vector_studio_select: No layer or artboard with id "Anim 01"');
    expect(note).toContain('- vector_studio_remove_keyframe: Not run: this turn is waiting');
    expect(note).toContain('What you tell the person must match this record.');
    expect(note.startsWith('<turn_record>')).toBe(true);
    expect(note.endsWith('</turn_record>')).toBe(true);
  });

  it('clips a long reason, and counts failures past the first twelve', () => {
    const calls = Array.from({ length: 15 }, (_, i) => ({ tool: `tool_${i}`, ok: false, error: 'x'.repeat(1_000) }));
    const note = ledgerNote(calls)!;
    expect(note).toContain('- tool_11: ');
    expect(note).not.toContain('- tool_12: ');
    expect(note).toContain('- … and 3 more');
    expect(note.length).toBeLessThan(12 * 300 + 800);
  });
});
