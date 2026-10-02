/** The fixture design system's control table, and the kind it registers. */
import type { ControlKindRegistration, ControlTableFile } from '@ouispec/bindings';

export const PRICE_RANGE: ControlKindRegistration = {
  kind: 'x-price-range',
  verb: 'Set the price band of',
  deriveSchema: {
    schema: {
      type: 'object',
      description: 'A price band: its lowest and highest price',
      properties: { low: { type: 'number' }, high: { type: 'number' } },
      required: ['low', 'high'],
    },
    props: { '/properties/low/minimum': 'min', '/properties/high/maximum': 'max' },
  },
};

export const TABLE: ControlTableFile = {
  $kinds: [PRICE_RANGE],
  Button: { kind: 'button', callbacks: ['onClick'], titleProps: ['children'] },
  Choice: { kind: 'choice', callbacks: ['onChange'], options: { prop: 'options', value: 'value', title: 'label' }, titleProps: ['label'] },
  PriceRange: { kind: 'x-price-range', callbacks: ['onChange'], schemaProps: { min: 'min', max: 'max' }, titleProps: ['label'] },
  OrderCard: {
    callbacks: [],
    slots: { open: { kind: 'button', callback: 'onOpen' }, cancel: { kind: 'button', callback: 'onCancel' } },
    entries: { prop: 'menuItems', kind: 'button', callback: 'onClick', titleKey: 'label' },
    titleProps: ['title'],
  },
  Facts: { callbacks: [], display: { itemsProp: 'facts', labelKey: 'label' }, titleProps: ['title'] },
};

export const PACKAGE_JSON = { name: '@kit/ds', oui: { agentControls: './agent-controls.json' } };
