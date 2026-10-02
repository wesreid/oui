/** Mapped controls imported past the bound module, by name and through a namespace. */
import * as Kit from 'acme-kit';
import { Picker as KitPicker } from 'acme-kit';

export function DirectPage() {
  return (
    <>
      <KitPicker label="Colour" options={[]} onPick={() => {}} />
      <Kit.Press onPress={() => {}}>Paint</Kit.Press>
    </>
  );
}
