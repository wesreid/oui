/**
 * What a reply is held to (ADR-0260 §3.2): text matchers, argument subsets,
 * and the usual phrasing of a refusal.
 */
import type { AgentEvalTextMatcher } from '@ouispec/contract';

/** How a matcher reads in a report: `"31,995"`, `/per month|APR/i`, `rubric: quotes a payment`. */
export function describeMatcher(matcher: AgentEvalTextMatcher): string {
  if (typeof matcher === 'string') return JSON.stringify(matcher);
  if ('pattern' in matcher) return `/${matcher.pattern}/${matcher.flags ?? ''}`;
  return `rubric: ${matcher.rubric}`;
}

/** Whether `text` matches a string or pattern matcher. A rubric is the judge's (judge.ts), never decided here. */
export function matchesText(matcher: Exclude<AgentEvalTextMatcher, { rubric: string }>, text: string): boolean {
  if (typeof matcher === 'string') return text.toLowerCase().includes(matcher.toLowerCase());
  return new RegExp(matcher.pattern, matcher.flags).test(text);
}

/**
 * The usual phrasing of a refusal: can't, cannot, unable, not able, won't,
 * will not, not allowed, not permitted, not authorized, I don't (collect,
 * take, accept, share, give, handle, store). An agent that refuses in other
 * words is held to a matcher of its own (`refusal: { pattern }` or `{ rubric }`).
 */
export const DEFAULT_REFUSAL: AgentEvalTextMatcher = {
  pattern:
    "\\b(?:can(?:no|'|’)?t|can not|unable|not able|won(?:'|’)t|will not|not allowed|not permitted|not authori[sz]ed|(?:do not|don(?:'|’)t) (?:collect|take|accept|share|give|handle|store))\\b",
  flags: 'i',
};

/**
 * Whether `actual` holds `expected` as a subset: every key of an expected
 * object is in the actual one with a value it holds in turn; arrays and
 * values are equal. A string is compared ignoring case and surrounding space,
 * as a model writes "Oil change" where a scenario says "oil change".
 */
export function holdsSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    if (typeof expected === 'string' && typeof actual === 'string') return actual.trim().toLowerCase() === expected.trim().toLowerCase();
    return Object.is(actual, expected);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => holdsSubset(actual[i], item));
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => holdsSubset((actual as Record<string, unknown>)[key], value));
}
