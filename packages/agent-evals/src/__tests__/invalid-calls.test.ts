/**
 * What a turn record counts as an invalid tool call: a call the model wrote
 * wrong, from the result the worker stored for it.
 */
import { describe, expect, it } from 'vitest';
import { invalidCall } from '../run.js';

describe('an invalid tool call', () => {
  it('is a call to a tool its step did not offer, as agent-worker 0.32.3 stores it', () => {
    expect(
      invalidCall(
        JSON.stringify({
          success: false,
          notRun: true,
          unavailable: true,
          error: '"present_options" is not one of the tools you can use now, so the call did not run and nothing was shown to the user. Carry on with the tools you have, or answer in words.',
        }),
      ),
    ).toBe(true);
  });

  it('is one as earlier workers stored it, with the model SDK’s own error', () => {
    expect(invalidCall(JSON.stringify({ success: false, notRun: true, error: "Model tried to call unavailable tool 'present_options'. Available tools: searchInventory." }))).toBe(true);
    expect(invalidCall(JSON.stringify({ success: false, notRun: true, invalidInput: true, error: 'Invalid input for tool present_options: JSON parsing failed' }))).toBe(true);
    expect(invalidCall(JSON.stringify({ success: false, invalidInput: true, error: 'Invalid input for "searchInventory": query is required' }))).toBe(true);
  });

  it('is not a call that was refused for another reason, or one that ran', () => {
    expect(invalidCall(JSON.stringify({ success: false, policyDenied: true, error: 'Not now.' }))).toBe(false);
    expect(invalidCall(JSON.stringify({ success: false, notRun: true, error: 'Not run: this turn is waiting for the user’s approval.' }))).toBe(false);
    expect(invalidCall(JSON.stringify({ matches: 2 }))).toBe(false);
    expect(invalidCall('not json')).toBe(false);
  });
});
