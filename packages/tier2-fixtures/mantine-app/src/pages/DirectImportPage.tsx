/** A page that imports Mantine's Select itself, past the bound module: the assistant could never use it. */
import { useState } from 'react';

import { Stack } from '@mantine/core';
import { Select } from '@mantine/core';

export function DirectImportPage() {
  const [market, setMarket] = useState<string | null>('us');
  return (
    <Stack>
      <Select label="Market" data={['us', 'eu']} value={market} onChange={setMarket} />
    </Stack>
  );
}
