/** A page that imports Radix's Switch itself, past the bound module: the assistant could never use it. */
import { useState } from 'react';

import { Switch } from 'radix-ui';

export function DirectImportPage() {
  const [on, setOn] = useState(false);
  return <Switch.Root checked={on} onCheckedChange={setOn} aria-label="Extended hours" />;
}
