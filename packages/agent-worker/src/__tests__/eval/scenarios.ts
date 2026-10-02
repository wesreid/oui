/**
 * Eval Scenarios (W7.T2)
 *
 * 26+ scenarios across 8 categories. Each scenario specifies the user input,
 * expected tool calls (with partial arg matching), stop reasons, and bounds.
 */
import type { EvalScenario } from './fixtures.js';

// ─── Tour history fixture (reused by tour and multi-turn scenarios) ──────────

const tourHistory = [
  { role: 'user', content: 'Give me a guided tour' },
  { role: 'assistant', content: 'Welcome! Let me show you around your studio.' },
];

// ─── Navigation (3) ──────────────────────────────────────────────────────────

const navigation: EvalScenario[] = [
  {
    name: 'Navigate to /voices',
    category: 'navigation',
    context: { currentPath: '/home' },
    userMessage: 'Take me to the voices page',
    expectedTools: [
      { name: 'navigate', argsContain: { path: '/voices' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 2,
  },
  {
    name: 'Navigate to /productions',
    category: 'navigation',
    context: { currentPath: '/home' },
    userMessage: 'Show me the productions page',
    expectedTools: [
      { name: 'navigate', argsContain: { path: '/productions' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 2,
  },
  {
    name: 'Navigate to /characters',
    category: 'navigation',
    context: { currentPath: '/home' },
    userMessage: 'Go to characters',
    expectedTools: [
      { name: 'navigate', argsContain: { path: '/characters' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 2,
  },
];

// ─── Tour (3) — SDK-neutral: default policy applies no forced sequences ────
// With the default turn policy, tour messages are treated as normal turns.
// Product-specific tour behavior (forced navigate→present_options) is now
// the integrator's responsibility via a custom TurnPolicy.

const tour: EvalScenario[] = [
  {
    name: 'Initiate guided tour',
    category: 'tour',
    context: { currentPath: '/home' },
    userMessage: 'Give me a guided tour',
    expectedTools: [
      { name: 'navigate', argsContain: { path: '/home' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Next → Characters',
    category: 'tour',
    context: {
      currentPath: '/home',
      history: [...tourHistory],
    },
    userMessage: 'Next → Characters',
    expectedTools: [
      { name: 'navigate', argsContain: { path: '/characters' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Tell me more (elaborate)',
    category: 'tour',
    context: {
      currentPath: '/characters',
      history: [...tourHistory],
    },
    userMessage: 'Tell me more about this page',
    expectedTools: [
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
];

// ─── Entity query (3) ────────────────────────────────────────────────────────

const entityQuery: EvalScenario[] = [
  {
    name: 'List characters',
    category: 'entity_query',
    context: { currentPath: '/characters' },
    userMessage: 'Show me all my characters',
    expectedTools: [
      { name: 'query_entities', argsContain: { entityType: 'Character' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Get specific voice',
    category: 'entity_query',
    context: { currentPath: '/voices' },
    userMessage: 'Show me the voice named "Sarah"',
    expectedTools: [
      { name: 'get_entity', argsContain: { entityType: 'Voice' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Search projects',
    category: 'entity_query',
    context: { currentPath: '/productions' },
    userMessage: 'Search for projects about marketing',
    expectedTools: [
      { name: 'query_entities', argsContain: { entityType: 'Project' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
];

// ─── Generation (4) ──────────────────────────────────────────────────────────

const generation: EvalScenario[] = [
  {
    name: 'Generate clip',
    category: 'generation',
    context: { currentPath: '/clips' },
    userMessage: 'Generate a clip of Sarah saying "Hello world"',
    expectedTools: [
      { name: 'generate_clip', argsContain: { text: 'Hello world' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Generate image',
    category: 'generation',
    context: { currentPath: '/images' },
    userMessage: 'Generate an image of a sunset over mountains',
    expectedTools: [
      { name: 'generate_image', argsContain: { prompt: 'sunset over mountains' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Clone voice',
    category: 'generation',
    context: { currentPath: '/voices' },
    userMessage: 'Clone my voice from the uploaded sample',
    expectedTools: [
      { name: 'clone_voice' },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Generate sound effect',
    category: 'generation',
    context: { currentPath: '/audio' },
    userMessage: 'Generate a thunderstorm sound effect',
    expectedTools: [
      { name: 'generate_sound', argsContain: { prompt: 'thunderstorm' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
];

// ─── OUI dispatch (5) ────────────────────────────────────────────────────────

const ouiDispatch: EvalScenario[] = [
  {
    name: 'Navigate via app-shell OUI',
    category: 'oui_dispatch',
    context: { currentPath: '/home' },
    userMessage: 'Navigate to the voices page',
    expectedTools: [
      { name: 'app-shell:navigate', argsContain: { path: '/voices' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 2,
  },
  {
    name: 'Create character via OUI',
    category: 'oui_dispatch',
    context: { currentPath: '/characters' },
    userMessage: 'Create a new character named "Alex"',
    expectedTools: [
      { name: 'characters:create', argsContain: { name: 'Alex' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Create clip via OUI',
    category: 'oui_dispatch',
    context: { currentPath: '/clips' },
    userMessage: 'Create a new clip with the default character',
    expectedTools: [
      { name: 'clips:create' },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Dataviz action via OUI',
    category: 'oui_dispatch',
    context: { currentPath: '/dataviz' },
    userMessage: 'Show me engagement metrics for last week',
    expectedTools: [
      { name: 'dataviz:query', argsContain: { timeRange: 'last_week' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Distribution action via OUI',
    category: 'oui_dispatch',
    context: { currentPath: '/distribution' },
    userMessage: 'Create a new campaign for the holiday season',
    expectedTools: [
      { name: 'distribution:create_campaign', argsContain: { name: 'holiday season' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
];

// ─── Failure (3) ─────────────────────────────────────────────────────────────

const failure: EvalScenario[] = [
  {
    name: 'Unknown tool invocation',
    category: 'failure',
    context: { currentPath: '/home' },
    userMessage: 'Use the nonexistent_tool to do something',
    expectedTools: [
      { name: 'nonexistent_tool' },
    ],
    expectedStopReason: 'complete',
    maxRoundsExpected: 2,
  },
  {
    name: 'Tool timeout',
    category: 'failure',
    context: { currentPath: '/clips' },
    userMessage: 'Generate a clip (tool will timeout)',
    expectedTools: [
      { name: 'generate_clip_slow' },
    ],
    expectedStopReason: 'complete',
    maxRoundsExpected: 2,
  },
  {
    name: 'Tool execution error',
    category: 'failure',
    context: { currentPath: '/images' },
    userMessage: 'Generate an image (tool will error)',
    expectedTools: [
      { name: 'generate_image_error' },
    ],
    expectedStopReason: 'complete',
    maxRoundsExpected: 2,
  },
];

// ─── Bounds (3) ──────────────────────────────────────────────────────────────

const bounds: EvalScenario[] = [
  {
    name: 'Quota refusal after 2 side-effecting calls',
    category: 'bounds',
    context: { currentPath: '/clips' },
    userMessage: 'Generate 5 clips in a row',
    expectedTools: [
      { name: 'generate_clip' },
      { name: 'generate_clip' },
      { name: 'generate_clip' }, // This one gets quota refusal
    ],
    expectedStopReason: 'complete',
    maxRoundsExpected: 4,
  },
  {
    name: 'Step count limit reached',
    category: 'bounds',
    context: { currentPath: '/home' },
    userMessage: 'Do a complex multi-step task that exceeds the round limit',
    expectedTools: [
      { name: 'search' },
      { name: 'search' },
    ],
    expectedStopReason: 'step_count',
    maxRoundsExpected: 2,
  },
  {
    name: 'Deadline abort',
    category: 'bounds',
    context: { currentPath: '/home' },
    userMessage: 'Run a task that will exceed the deadline',
    expectedTools: [],
    expectedStopReason: 'deadline',
    maxRoundsExpected: 1,
  },
];

// ─── Multi-turn (2) ──────────────────────────────────────────────────────────

const multiTurn: EvalScenario[] = [
  {
    name: 'Follow-up question retaining context',
    category: 'multi_turn',
    context: {
      currentPath: '/characters',
      history: [
        { role: 'user', content: 'Show me my characters' },
        { role: 'assistant', content: 'Here are your characters: Alex, Sarah, Mike.' },
      ],
    },
    userMessage: 'Tell me more about Alex',
    expectedTools: [
      { name: 'get_entity', argsContain: { entityType: 'Character' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
  {
    name: 'Reference to prior tool result',
    category: 'multi_turn',
    context: {
      currentPath: '/voices',
      history: [
        { role: 'user', content: 'List all voices' },
        { role: 'assistant', content: 'Here are your voices: Sarah (English), Marco (Italian), Yuki (Japanese).' },
      ],
    },
    userMessage: 'Clone the first voice on that list',
    expectedTools: [
      { name: 'clone_voice', argsContain: { sourceVoice: 'Sarah' } },
      { name: 'present_options' },
    ],
    expectedStopReason: 'present_options',
    maxRoundsExpected: 3,
  },
];

// ─── All scenarios ───────────────────────────────────────────────────────────

export const scenarios: EvalScenario[] = [
  ...navigation,
  ...tour,
  ...entityQuery,
  ...generation,
  ...ouiDispatch,
  ...failure,
  ...bounds,
  ...multiTurn,
];

// Verify minimum counts per category
const categoryCounts = scenarios.reduce<Record<string, number>>((acc, s) => {
  acc[s.category] = (acc[s.category] ?? 0) + 1;
  return acc;
}, {});

const MINIMUM_COUNTS: Record<string, number> = {
  navigation: 3,
  tour: 3,
  entity_query: 3,
  generation: 4,
  oui_dispatch: 5,
  failure: 3,
  bounds: 3,
  multi_turn: 2,
};

for (const [category, min] of Object.entries(MINIMUM_COUNTS)) {
  if ((categoryCounts[category] ?? 0) < min) {
    throw new Error(
      `Eval corpus: category "${category}" has ${categoryCounts[category] ?? 0} scenarios, minimum is ${min}`,
    );
  }
}
