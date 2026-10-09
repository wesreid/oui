/**
 * The current date and time, as the user's clock shows it, on every turn.
 *
 * A model has no clock. Asked to "restore yesterday's version", the assistant
 * read entries dated 2 October as "a different day" from today — which was
 * 2 October — because nothing in its turn said what today was.
 *
 * - **The instant** is the worker's own (`now`): a client cannot skew it.
 * - **The zone** is the user's, sent by their browser with the turn
 *   (`context.timeZone`, an IANA name), so "today" and "yesterday" are the
 *   days their wall clock shows, not the server's. An unknown or missing zone
 *   is UTC, and the note says so.
 * - **Where it goes:** after the conversation, with what else is true only
 *   now (step-messages.ts). Never in the system prompt, where one changing
 *   minute would invalidate the cached prefix on every turn, and never on the
 *   user's message, which the next turn sends without it.
 */

/** The key under a turn's context that carries the user's IANA time zone. */
export const CLIENT_TIME_ZONE_KEY = 'timeZone';

/** The user's time zone from the turn's context, when it is one this runtime knows; else null. */
export function readClientTimeZone(context: Record<string, unknown> | null | undefined): string | null {
  const zone = context?.[CLIENT_TIME_ZONE_KEY];
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return null;
  try {
    // Throws a RangeError for a name that is not a time zone.
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** One part of a date in a zone, as Intl names it. */
function part(now: Date, timeZone: string, options: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).formatToParts(now).find((p) => p.type === type)?.value ?? '';
}

/** A zone's offset from UTC at `now`, as `UTC+02:00`. */
function utcOffset(now: Date, timeZone: string): string {
  const name = part(now, timeZone, { timeZoneName: 'longOffset' }, 'timeZoneName');
  // "GMT+02:00", or plain "GMT" for no offset.
  const offset = name.replace(/^GMT/, '');
  return `UTC${offset || '+00:00'}`;
}

/**
 * What the model is told about now: the day and date, the ISO date, the time
 * to the minute, and whose zone they are in.
 */
export function clockText(now: Date, timeZone: string | null): string {
  const zone = timeZone ?? 'UTC';
  const weekday = part(now, zone, { weekday: 'long' }, 'weekday');
  const day = part(now, zone, { day: 'numeric' }, 'day');
  const month = part(now, zone, { month: 'long' }, 'month');
  const year = part(now, zone, { year: 'numeric' }, 'year');
  const iso = [year, part(now, zone, { month: '2-digit' }, 'month'), part(now, zone, { day: '2-digit' }, 'day')].join('-');
  const time = `${part(now, zone, { hour: '2-digit', hourCycle: 'h23' }, 'hour')}:${part(now, zone, { minute: '2-digit' }, 'minute').padStart(2, '0')}`;
  const where = timeZone
    ? `in the user's time zone, ${timeZone} (${utcOffset(now, timeZone)})`
    : "UTC (the user's time zone is not known, so say UTC when you name a time)";
  return [
    '<now>',
    `It is ${weekday} ${day} ${month} ${year} (${iso}), ${time} ${where}.`,
    'Days the user names — today, yesterday, this morning, last week — are days on that clock. ' +
      'A date or time in the page’s data or a tool’s result is UTC unless it carries its own offset: convert it to this zone before saying which day it falls on.',
    '</now>',
  ].join('\n');
}
