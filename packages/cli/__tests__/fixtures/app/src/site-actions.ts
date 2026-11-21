// A room the app's frame registers, so it is open on every page.
export const SITE_CATALOG = {
  room: 'demo-site',
  title: 'Site capture',
  description: 'Opens a site the person named.',
  actions: [
    {
      kind: 'action' as const,
      id: 'capture',
      title: 'Capture a site',
      description: 'Captures the page the person named.',
      control: 'Brand › From your website',
      effect: 'edit' as const,
      input: { type: 'object' as const, properties: { url: { type: 'string' as const } } },
      run: () => ({ ok: true as const }),
    },
  ],
  fields: [],
  commands: [],
  observations: [],
};
