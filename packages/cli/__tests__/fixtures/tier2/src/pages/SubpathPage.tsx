/** A mapped control imported past the bound module, from a subpath export of its package. */
import { Picker } from 'acme-kit/picker';

export function SubpathPage() {
  return <Picker label="Colour" options={[]} onPick={() => {}} />;
}
