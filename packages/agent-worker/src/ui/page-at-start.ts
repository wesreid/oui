/**
 * The page a person's message was sent from, kept with the message.
 *
 * A turn reads the page it began on from the snapshot its message carries
 * (`context.oui`), and that snapshot is never stored: once the page moved on,
 * a later turn asked "why did you lead with the Rogue?" had nothing that said
 * what the page had shown. So a turn keeps a digest of it (state-digest.ts) as
 * its message's `pageAtStart`, which the host stores with the message and
 * hands back in history (`TurnHistoryMessage.pageAtStart`).
 *
 * It is made when the turn begins and sent with the turn's message on every
 * step in the words history gives it later: the message reads the same in the
 * turn that sent it and in every turn after, so the prompt cache still reads
 * the conversation up to it.
 */

/** Opens and closes the note on a person's message that says what their page showed. */
export const PAGE_AT_START_OPEN = '<page_at_start>';
export const PAGE_AT_START_CLOSE = '</page_at_start>';

/** The note a message carries for the page it was sent from. */
export function pageAtStartNote(digest: string): string {
  return `${PAGE_AT_START_OPEN}When this message was sent, the page showed: ${digest}${PAGE_AT_START_CLOSE}`;
}

/** A person's message as the model reads it, with the note on the page it was sent from when there is one. */
export function withPageAtStart(content: string, digest: string | null | undefined): string {
  return digest ? `${content}\n\n${pageAtStartNote(digest)}` : content;
}
