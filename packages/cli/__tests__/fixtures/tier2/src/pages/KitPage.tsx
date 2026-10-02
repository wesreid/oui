/** Every way a page uses a bound control: controlled, spread, compound with readable and unreadable items. */
import { useState } from 'react';

import { Menu, Picker, Press } from '../agent/generated/bound/acme-kit';

const COLOURS = [
  { id: 'red', name: 'Red' },
  { id: 'blue', name: 'Blue' },
];

const SIZES = ['s', 'm'];

export function KitPage({ extra }: { extra: { value?: string } }) {
  const [colour, setColour] = useState('red');
  const [size, setSize] = useState('s');
  return (
    <>
      <Picker
        label="Colour"
        options={COLOURS}
        value={colour}
        onPick={(_event, id) => setColour(id)}
        agent={{ id: 'kit.colour', description: 'The colour to paint with' }}
      />
      <Picker label="Shade" options={COLOURS} {...extra} onPick={() => {}} agent={{ id: 'kit.shade', description: 'The shade of the colour' }} />
      <Press onPress={() => {}} agent={{ id: 'kit.paint', description: 'Paint the canvas' }}>
        Paint
      </Press>
      <Menu.Root label="Size" selected={size} onSelect={setSize} agent={{ id: 'kit.size', description: 'The brush size' }}>
        <Menu.Label>Sizes</Menu.Label>
        <Menu.Choice id="s">Small</Menu.Choice>
        <Menu.Choice id="m">
          <b>Medium</b>
        </Menu.Choice>
      </Menu.Root>
      <Menu.Root label="Grid" selected={size} onSelect={setSize} agent={{ id: 'kit.grid', description: 'The grid size' }}>
        {SIZES.map(s => (
          <Menu.Choice key={s} id={s}>
            {s}
          </Menu.Choice>
        ))}
      </Menu.Root>
    </>
  );
}
