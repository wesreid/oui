/**
 * The user's IANA time zone, as their browser resolves it ("Europe/Paris"),
 * or undefined where the runtime cannot say. Sent with every turn so the
 * worker dates the turn on the user's clock, not the server's.
 */
export function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 ? zone : undefined;
  } catch {
    return undefined;
  }
}
