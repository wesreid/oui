/**
 * The turn's own record of what its calls did (ADR-0244 §2.5).
 *
 * A model writes its closing message from memory of a long turn, and a
 * failure a dozen steps back is easy to pass over: on 2026-10-02 the
 * assistant asked for a 2-second duration, got 5, and told the person 5 was
 * better; it reported five layers centred when two had not moved. The worker
 * knows what each call returned, so before every step after one did not
 * succeed it says so again, in one place, and the reply is held to it.
 *
 * Nothing is added while every call has succeeded: the record costs nothing
 * on a turn that went well.
 */

/** One call of the turn. */
export interface LedgerEntry {
  tool: string;
  ok: boolean;
  /** Why it did not succeed, or did not run, in the words the model was given. */
  error?: string;
}

export interface TurnLedger {
  record(entry: LedgerEntry): void;
  entries(): readonly LedgerEntry[];
  /** The note for the next step, or null while every call has succeeded. */
  note(): string | null;
}

/** How much of each failure's reason the note repeats. */
const MAX_REASON_CHARS = 240;
/** How many failures the note lists one by one; the rest are counted. */
const MAX_LISTED = 12;

const clip = (text: string) => (text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…` : text);

export function createTurnLedger(): TurnLedger {
  const calls: LedgerEntry[] = [];
  return {
    record: (entry) => void calls.push(entry),
    entries: () => calls,
    note: () => ledgerNote(calls),
  };
}

/** What the model is told about the turn so far, when any call did not succeed. */
export function ledgerNote(calls: readonly LedgerEntry[]): string | null {
  const failed = calls.filter((c) => !c.ok);
  if (failed.length === 0) return null;
  const listed = failed
    .slice(0, MAX_LISTED)
    .map((c) => `- ${c.tool}: ${clip(c.error ?? 'did not succeed')}`)
    .join('\n');
  const more = failed.length > MAX_LISTED ? `\n- … and ${failed.length - MAX_LISTED} more` : '';
  return (
    `<turn_record>\n` +
    `This turn has made ${calls.length} call${calls.length === 1 ? '' : 's'}; ${failed.length} did not succeed:\n` +
    `${listed}${more}\n` +
    `What you tell the person must match this record. For each of these, either it has since been done by a later call ` +
    `that succeeded, or your reply says it was not done and why. Never describe a call that did not succeed as done, ` +
    `and never present what you got in place of what was asked as if it were what was asked.\n` +
    `</turn_record>`
  );
}
