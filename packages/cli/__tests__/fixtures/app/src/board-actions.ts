// A room catalog the app declares itself, with entries made by a function:
// not statically readable, so the generator loads it.
function saveAction(format: string) {
  return {
    kind: 'action' as const,
    id: `save-${format}`,
    title: `Save ${format.toUpperCase()}`,
    description: `Saves the artwork as ${format.toUpperCase()}.`,
    control: `Header › Save ${format.toUpperCase()}`,
    effect: 'file' as const,
    input: { type: 'object' as const, properties: {} },
    run: () => ({ ok: true as const }),
  };
}

export const BOARD_CATALOG = {
  room: 'demo-board',
  title: 'Board',
  description: 'The page around the demo room.',
  actions: [saveAction('svg'), saveAction('png')],
  fields: [],
  commands: [],
  observations: [],
};
