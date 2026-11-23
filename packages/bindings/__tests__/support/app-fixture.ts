/**
 * A studio app as its generator emits it, for the app-wide readers' tests:
 * a character's page whose Images tab adds pictures through a
 * dialog, a gallery of generated images, a picture studio's home and its
 * editor, whose room removes, fills, relights and expands, and the app's frame.
 *
 * It has the shapes and the words a real build has: control descriptions with
 * their tool lead-in, room actions with their menu path, a room's fields and
 * commands in its generic actions' inputs, navigate effects between pages.
 */
import type { GeneratedKnowledge, ManifestAction, ManifestSurface, OuiManifest, PageKnowledge } from '@ouispec/contract';

const route = (path: string, title: string) => ({ kind: 'route' as const, path, title });

function control(name: string, title: string, description: string, at: { path: string; title: string }, extra: Partial<ManifestAction> = {}): ManifestAction {
  return {
    name,
    id: name.replace(/_/g, '.'),
    source: 'control',
    control: 'button',
    title,
    description: `Press "${title}": ${description}`,
    input: { type: 'object', properties: {}, additionalProperties: false },
    reach: [route(at.path, at.title)],
    ...extra,
  };
}

function room(id: string, title: string, description: string, where: string, effect: ManifestAction['effect'], extra: Partial<ManifestAction> = {}): ManifestAction {
  return {
    name: `image_studio_${id.replace(/-/g, '_')}`,
    id: `image-studio/action/${id}`,
    source: 'room-action',
    title,
    description: `${title}: ${description} (${where})`,
    input: { type: 'object', properties: {}, additionalProperties: false },
    effect,
    reach: [{ kind: 'room', room: 'image-studio', where }],
    ...extra,
  };
}

const CHARACTER = { path: '/characters/:id', title: 'Character Detail' };
const CHARACTERS = { path: '/characters', title: 'Characters' };
const IMAGES = { path: '/images', title: 'Images' };
const IMAGE_HOME = { path: '/image', title: 'Image Studio' };
const IMAGE_EDITOR = { path: '/image/:imageId', title: 'Image Editor' };

const addDialog = { kind: 'dialog' as const, title: 'Add images', openedBy: ['characters.images.add'] };
const imagesTab = { kind: 'tab' as const, binding: 'characters.tabs', value: 'images', title: 'Images' };

const references = {
  type: 'array',
  description: 'Pictures that condition the result, each by one of layerId, characterId or assetId: a character to keep, a background, a style.',
  items: {
    type: 'object',
    properties: {
      assetId: { type: 'string', description: 'A library picture, by id (browse-library).' },
      characterId: { type: 'string', description: 'A library character, by id (browse-library).' },
      layerId: { type: 'string', description: 'A layer of the document, by id.' },
    },
  },
} as const;

export const surfaces: ManifestSurface[] = [
  {
    id: 'page:CharactersPage',
    kind: 'page',
    title: 'Characters',
    description: 'Create and manage your digital characters',
    routes: ['/characters'],
    observations: [],
    actions: [
      control('characters_open', 'Open', 'Open a character.', CHARACTERS, { itemized: true, effect: { kind: 'navigate', to: '/characters/:id' } }),
      control('characters_new', 'New Character', 'Start a new character.', CHARACTERS, { effect: { kind: 'navigate', to: '/characters/create' } }),
      control('characters_delete', 'Delete', 'Delete a character.', CHARACTERS, { itemized: true, destructive: true, effect: { kind: 'mutate', operation: 'deleteCharacter' } }),
    ],
  },
  {
    id: 'page:CharacterDetailPage',
    kind: 'page',
    title: 'Character Detail',
    description: '',
    routes: ['/characters/:id', '/characters/:id/:tab'],
    observations: [],
    actions: [
      control('characters_tabs', 'Tabs', 'Choose a tab.', CHARACTER, { control: 'tabs' }),
      control('characters_images_add', 'Add Images', 'Open the Add images dialog: select several of the account’s generated images and add them together, or add files the person attached.', CHARACTER, {
        reach: [route(CHARACTER.path, CHARACTER.title), imagesTab],
        effect: { kind: 'open', container: 'characters.images.add-dialog' },
      }),
      control('characters_images_remove', 'Remove', 'Remove an image from the character.', CHARACTER, {
        itemized: true,
        reach: [route(CHARACTER.path, CHARACTER.title), imagesTab],
        effect: { kind: 'mutate', operation: 'deleteCharacterImage' },
      }),
      control('characters_images_set_primary', 'Set Primary', 'Make an image the character’s primary one, which clips and conversations start from.', CHARACTER, {
        itemized: true,
        reach: [route(CHARACTER.path, CHARACTER.title), imagesTab],
        effect: { kind: 'mutate', operation: 'updateCharacter' },
      }),
      control('characters_images_add_select', 'Select', 'Add an image from the list shown to the selection, or take it out. It is one per row: say which row with `item`.', CHARACTER, {
        itemized: true,
        reach: [route(CHARACTER.path, CHARACTER.title), imagesTab, addDialog],
      }),
      control('characters_images_add_confirm', 'Add images', 'Add every selected image to the character, each as its original file.', CHARACTER, {
        reach: [route(CHARACTER.path, CHARACTER.title), imagesTab, addDialog],
        effect: { kind: 'mutate', operation: 'createCharacterImage' },
      }),
      {
        ...control('characters_images_add_device', 'This device', 'Add picture files the person attached to the conversation to the character’s images.', CHARACTER, {
          control: 'file',
          reach: [route(CHARACTER.path, CHARACTER.title), imagesTab, addDialog],
        }),
        description: 'Give a file to "This device": Add picture files the person attached to the conversation to the character’s images.',
        input: {
          type: 'object',
          properties: { value: { type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file' }, description: 'The id of a file the person attached' } },
          required: ['value'],
        },
      },
      control('characters_rename', 'Rename', 'Rename the character.', CHARACTER, { effect: { kind: 'mutate', operation: 'updateCharacter' } }),
    ],
  },
  {
    id: 'page:CharacterCreatePage',
    kind: 'page',
    title: 'Create Character',
    description: 'Make a new character.',
    routes: ['/characters/create'],
    observations: [],
    actions: [control('characters_create_save', 'Create', 'Create the character.', { path: '/characters/create', title: 'Create Character' }, { effect: { kind: 'mutate', operation: 'createCharacter' } })],
  },
  {
    id: 'page:ImagesPage',
    kind: 'page',
    title: 'Images',
    description: 'Generate AI-powered images from text prompts',
    routes: ['/images'],
    observations: [],
    actions: [
      control('images_new', 'New Image', 'Generate a new image from a prompt.', IMAGES, { effect: { kind: 'navigate', to: '/images/create' } }),
      control('images_open_in_editor', 'Open in Image Studio', 'Edit this generated image in the Image Studio editor.', IMAGES, {
        itemized: true,
        effect: { kind: 'navigate', to: '/image/:imageId' },
      }),
    ],
  },
  {
    id: 'page:ImageEditorHomePage',
    kind: 'page',
    title: 'Image Studio',
    description: 'Pictures in layers, edited without changing the original, saved to your account as you work.',
    routes: ['/image'],
    observations: [],
    actions: [
      control('image_home_new', 'New image', 'Start a new image.', IMAGE_HOME, { effect: { kind: 'navigate', to: '/image/:imageId' } }),
      control('image_home_open', 'Open', 'Open an image.', IMAGE_HOME, { itemized: true, effect: { kind: 'navigate', to: '/image/:imageId' } }),
    ],
  },
  {
    id: 'page:ImageEditorPage',
    kind: 'page',
    title: 'Image Editor',
    description: '',
    routes: ['/image/:imageId'],
    observations: [],
    actions: [control('image_editor_home', 'Back', 'Back to the Image Studio.', IMAGE_EDITOR, { effect: { kind: 'navigate', to: '/image' } })],
  },
  {
    id: 'room:image-studio',
    kind: 'room',
    title: 'Image Studio',
    description: 'A layered picture editor.',
    routes: ['/image/:imageId'],
    observations: [],
    actions: [
      room('generative-remove', 'Remove', 'Removes what is selected and fills the area from what surrounds it, as a new generative layer above the active one, masked to the selection.', 'Edit › Remove', { kind: 'job', estimatedDuration: '10 seconds' }, {
        input: { type: 'object', properties: { prompt: { type: 'string', description: 'What should be there instead, in words.' }, references } },
      }),
      room('generative-fill', 'Generative Fill', 'Fills what is selected with what the prompt describes.', 'Edit › Generative Fill', { kind: 'job', estimatedDuration: '10 seconds' }, {
        input: { type: 'object', properties: { prompt: { type: 'string', description: 'What to paint into the selection.' }, references } },
      }),
      room('edit-by-instruction', 'Edit by Instruction', 'Changes the picture as an instruction in words says.', 'Edit › Edit by Instruction', { kind: 'job', estimatedDuration: '10 seconds' }),
      room('relight', 'Relight', 'Lights the picture again, from a direction and a colour.', 'Edit › Relight', { kind: 'job', estimatedDuration: '10 seconds' }),
      room('generative-expand', 'Generative Expand', 'Widens the canvas and paints what lies beyond its edges.', 'Image › Generative Expand', { kind: 'job', estimatedDuration: '10 seconds' }),
      room('select-object', 'Select an object', 'Selects the object inside a rectangle, or the object a point is on.', 'Object Selection tool: drag a rectangle', 'selection'),
      room('select-all', 'Select all', 'Selects the whole canvas.', 'Select › All (⌘A)', 'selection'),
      room('deselect', 'Deselect', 'Selects nothing.', 'Select › Deselect (⌘D)', 'selection'),
      room('place-image', 'Place a picture as a layer', 'Places a picture file as a new layer.', 'File › Place Embedded…', 'edit', {
        input: {
          type: 'object',
          properties: { file: { type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file', mediaTypes: ['image/png', 'image/jpeg'] }, description: 'The picture file.' } },
        },
      }),
      room('delete-layer', 'Delete layers', 'Deletes the chosen layers.', 'Layers panel › Delete Layer', 'edit', { destructive: true }),
      room('set-properties', 'Set properties', 'Sets fields of the active layer or tool.', 'Properties panel', 'edit', {
        input: {
          type: 'object',
          properties: {
            values: {
              type: 'object',
              properties: {
                'brush-size': { type: 'number', description: 'Tool options › Size: How wide the brush paints, in pixels.' },
                opacity: { type: 'number', description: 'Layers panel › Opacity: How much of the layer shows.' },
              },
            },
          },
        },
      }),
      room('run-command', 'Run a command', 'Runs one of the editor’s commands.', 'The menus and keys', 'edit', {
        input: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'tool.lasso = Lasso (L): Selects inside a freehand outline.\nedit.undo = Undo (⌘Z): Takes back the last change.',
            },
          },
        },
      }),
    ],
  },
  {
    id: 'shell:StudioShell',
    kind: 'shell',
    title: 'Studio Shell',
    description: 'The frame.',
    routes: ['*'],
    observations: [],
    actions: [control('shell_capture_website', 'Capture a website', 'Capture a website’s screens and brand.', { path: '*', title: 'Studio Shell' }, { effect: { kind: 'job', estimatedDuration: '1 minute' } })],
  },
  {
    id: 'app:navigation',
    kind: 'navigation',
    title: 'Pages',
    description: 'Every page of the app.',
    routes: ['/characters', '/characters/:id', '/images', '/image', '/image/:imageId'],
    observations: [],
    actions: [{ name: 'app_navigate', id: 'app.navigate', source: 'navigation', title: 'Go to a page', description: 'Go to a page.', input: { type: 'object' }, reach: [] }],
  },
];

export const manifest: OuiManifest = { version: 1, buildId: 'build-fixture', surfaces };

function page(surface: string, title: string, routes: string[], detail: string, recipes: string[] = []): PageKnowledge {
  return {
    surface,
    routes,
    summary: { title, content: `${title} (${routes.join(', ')}): ${detail.split('\n')[0]}` },
    detail: { title: `${title} (${routes.join(', ')})`, content: detail },
    relationships: { title: `${title}: how things relate`, content: `${title} relates to the other pages.` },
    recipes: recipes.map(name => ({ name, trigger: `Doing ${name}`, steps: ['One.', 'Two.'] })),
    adjacent: [],
  };
}

export const knowledge: GeneratedKnowledge = {
  version: 1,
  buildId: 'build-fixture',
  overview: { title: 'The app’s pages', content: 'Every page.' },
  pages: [
    page('page:CharactersPage', 'Characters', ['/characters'], 'Create and manage your digital characters.'),
    page('page:CharacterDetailPage', 'Character Detail', ['/characters/:id', '/characters/:id/:tab'], 'Offers Add Images, Remove and Set Primary.', ['Use the "Add images" dialog']),
    page('page:CharacterCreatePage', 'Create Character', ['/characters/create'], 'Make a new character.'),
    page('page:ImagesPage', 'Images', ['/images'], 'Generate AI-powered images from text prompts.'),
    page('page:ImageEditorHomePage', 'Image Studio', ['/image'], 'Pictures in layers.'),
    page('page:ImageEditorPage', 'Image Editor', ['/image/:imageId'], `Offers Remove, Generative Fill, Edit by Instruction and Relight.\n${'A line of the editor’s knowledge.\n'.repeat(900)}`, [
      'Change a property in the Image Studio',
    ]),
  ],
};
