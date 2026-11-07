import { describe, expect, it } from 'vitest';
import {
  RESUME_GATHER_MS,
  RESUME_MAX_IN_A_ROW,
  RESUME_MAX_REQUESTS,
  RESUME_REQUEST_ID_MAX_CHARS,
  resumeRefusal,
  type ResumeContinuation,
} from '../index.js';
import * as browser from '../browser.js';

describe('the resume continuation', () => {
  it('takes 1 to 8 request ids, each a non-empty string of at most 200 characters', () => {
    expect(RESUME_MAX_REQUESTS).toBe(8);
    expect(RESUME_REQUEST_ID_MAX_CHARS).toBe(200);
    const one: ResumeContinuation = { requestIds: ['call_1'] };
    expect(resumeRefusal(one)).toBeNull();
    expect(resumeRefusal({ requestIds: Array.from({ length: 8 }, (_, i) => `call_${i}`) })).toBeNull();
    expect(resumeRefusal({ requestIds: ['x'.repeat(200)] })).toBeNull();
  });

  it('refuses anything else, saying why', () => {
    expect(resumeRefusal(undefined)).toMatch(/must be an object/);
    expect(resumeRefusal(null)).toMatch(/must be an object/);
    expect(resumeRefusal(['call_1'])).toMatch(/must be an object/);
    expect(resumeRefusal({})).toMatch(/1 to 8 request ids/);
    expect(resumeRefusal({ requestIds: [] })).toMatch(/1 to 8 request ids/);
    expect(resumeRefusal({ requestIds: Array.from({ length: 9 }, (_, i) => `call_${i}`) })).toMatch(/1 to 8 request ids/);
    expect(resumeRefusal({ requestIds: [''] })).toMatch(/non-empty string of at most 200/);
    expect(resumeRefusal({ requestIds: ['x'.repeat(201)] })).toMatch(/non-empty string of at most 200/);
    expect(resumeRefusal({ requestIds: [42] })).toMatch(/non-empty string/);
  });

  it('bounds a tab: three turns in a row, gathered over a second and a half, and is on the browser entry too', () => {
    expect(RESUME_MAX_IN_A_ROW).toBe(3);
    expect(RESUME_GATHER_MS).toBe(1_500);
    expect(browser.resumeRefusal).toBe(resumeRefusal);
    expect(browser.RESUME_MAX_IN_A_ROW).toBe(RESUME_MAX_IN_A_ROW);
  });
});
