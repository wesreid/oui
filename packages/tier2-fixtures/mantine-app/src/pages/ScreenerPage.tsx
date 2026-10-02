/**
 * A stock screener on Mantine, bound through the generated wrappers: every
 * Mantine control is imported from the bound module, never from
 * `@mantine/core`, so the assistant uses the same handlers the person does.
 */
import { useState } from 'react';

import { Group, Stack } from '@mantine/core';

import { Button, Modal, MultiSelect, NumberInput, Select, Switch, Tabs, TextInput } from '../agent/generated/bound/mantine-core';
import { LabeledSwitch } from '../LabeledSwitch';

const MARKETS = [
  { value: 'us', label: 'United States' },
  { value: 'eu', label: 'Europe' },
  { value: 'jp', label: 'Japan' },
];

const SECTORS = [
  { value: 'tech', label: 'Technology' },
  { value: 'energy', label: 'Energy' },
  { value: 'health', label: 'Health care' },
];

const SORTS = [
  { value: 'volume', label: 'Volume' },
  { value: 'change', label: 'Change' },
];

export interface ScreenerPageProps {
  /** Runs the screen; the result is what the app shows. */
  onRun?: (criteria: { market: string | null; sectors: string[]; symbol: string; minPrice: number | string; live: boolean }) => void;
  /** Whether the save dialog starts open. */
  saving?: boolean;
}

export function ScreenerPage({ onRun, saving: savingAtStart = false }: ScreenerPageProps) {
  const [market, setMarket] = useState<string | null>('us');
  const [sectors, setSectors] = useState<string[]>([]);
  const [symbol, setSymbol] = useState('');
  const [minPrice, setMinPrice] = useState<number | string>(10);
  const [live, setLive] = useState(false);
  const [alerts, setAlerts] = useState(true);
  const [view, setView] = useState<string | null>('results');
  const [saving, setSaving] = useState(savingAtStart);
  const [name, setName] = useState('');

  return (
    <Stack>
      <Group>
        <Select
          label="Market"
          data={MARKETS}
          value={market}
          onChange={setMarket}
          agent={{ id: 'screener.market', description: 'The market the screen searches' }}
        />
        <MultiSelect
          label="Sectors"
          data={SECTORS}
          value={sectors}
          onChange={setSectors}
          agent={{ id: 'screener.sectors', description: 'The sectors a stock must be in to match' }}
        />
        <TextInput
          label="Symbol"
          maxLength={8}
          value={symbol}
          onChange={event => setSymbol(event.currentTarget.value)}
          agent={{ id: 'screener.symbol', description: 'Only stocks whose ticker starts with this' }}
        />
        <NumberInput
          label="Minimum price"
          min={0}
          max={10000}
          step={1}
          value={minPrice}
          onChange={setMinPrice}
          agent={{ id: 'screener.min-price', description: 'The lowest share price a match may have, in dollars' }}
        />
        <Switch
          label="Live prices"
          checked={live}
          onChange={event => setLive(event.currentTarget.checked)}
          agent={{ id: 'screener.live', description: 'Whether prices update as they trade' }}
        />
        <LabeledSwitch
          label="Price alerts"
          on={alerts}
          onToggle={setAlerts}
          agent={{ id: 'screener.alerts', description: 'Whether matches send price alerts' }}
        />
        <Select
          label="Sort by"
          data={SORTS}
          defaultValue="volume"
          onChange={() => {}}
          agent={{ id: 'screener.sort', description: 'How matches are ordered' }}
        />
      </Group>

      <Tabs value={view} onChange={setView} aria-label="View" agent={{ id: 'screener.view', description: 'What the screener shows' }}>
        <Tabs.List>
          <Tabs.Tab value="results">Results</Tabs.Tab>
          <Tabs.Tab value="history">History</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <Group>
        <Button
          onClick={() => onRun?.({ market, sectors, symbol, minPrice, live })}
          agent={{ id: 'screener.run', description: 'Run the screen with these criteria' }}
        >
          Run screen
        </Button>
        <Button onClick={() => setSaving(true)} agent={{ id: 'screener.save', description: 'Save these criteria as a named screen' }}>
          Save screen
        </Button>
      </Group>

      <Modal
        opened={saving}
        onClose={() => setSaving(false)}
        title="Save screen"
        agent={{ id: 'screener.save-dialog', description: 'Naming the screen to save' }}
      >
        <TextInput
          label="Name"
          value={name}
          onChange={event => setName(event.currentTarget.value)}
          agent={{ id: 'screener.save-name', description: 'What the saved screen is called' }}
        />
        <Button onClick={() => setSaving(false)} agent={{ id: 'screener.save-confirm', description: 'Save the screen under this name' }}>
          Save
        </Button>
      </Modal>
    </Stack>
  );
}
