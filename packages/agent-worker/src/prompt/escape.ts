/**
 * Text set inside a tag the model reads (`<observation>…</observation>`,
 * `<capture_update>…</capture_update>`), so it can neither close that tag nor
 * open another: it stays data, never an instruction.
 */
export function escapeTagText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
