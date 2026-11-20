/**
 * What the SDK tells a step names only the tools the step offers
 * (prompt/step-tools.ts).
 *
 * Nova, 2026-11-19: a step its turn policy held to one tool still read the
 * SDK's "offer it with present_options", called `present_options` beside the
 * tool it was given, and the turn ended with no reply. Every rule the SDK
 * writes that names a tool is a `ToolRule`, and a step is told only the rules
 * whose tools it offers. Here: the rules a host renders into its own prompt,
 * filtered out of it for a limited step, and every line the worker writes
 * itself (the page index's, the turn's context lines, the files note, the
 * client's knowledge, the hand-back note).
 */
import { describe, expect, it } from 'vitest';
import { AGENT_UI_TOOLS } from '@ouispec/agent-core';
// What a product imports, from the package's root.
import { buildAgentSystemPrompt, EVERY_TOOL, offeredTools, systemPromptForTools, type OfferedTools } from '../index.js';
import { fullText, promptForTools, renderRule } from '../prompt/step-tools.js';
import { SDK_PROMPT_TOOL_RULES } from '../prompt/builder.js';
import type { AgentPersonaConfig } from '../prompt/types.js';
import { getToolStrategyRules } from '../prompt/rules/tool-strategy.js';
import { getUIControlRules } from '../prompt/rules/ui-control.js';
import { CAPTURE_WHEN, captureText, type TurnCapture } from '../prompt/capture.js';
import { HANDOFF_WHEN, handoffText, type TurnHandoff } from '../prompt/handoff.js';
import { LOOK_WHEN, visionText, type TurnVision } from '../prompt/vision.js';
import { ATTACHMENT_DATA_NOTE, attachmentDataNote } from '../attachments/content.js';
import { renderClientKnowledge, type ClientKnowledge } from '../ui/knowledge.js';
import { timeHandBackNote } from '../time-hand-back.js';
import { stepOfferedTools } from '../orchestrator.js';
import {
  ATTACHMENT_LIST_TOOL,
  ATTACHMENT_READ_TOOL,
  ATTACHMENT_VIEW_TOOL,
  CALL_HANDOFF_TOOL,
  CAPTURE_START_TOOL,
  CAPTURE_STATUS_TOOL,
  CAPTURE_STOP_TOOL,
  KNOWLEDGE_TOOL,
  LOOK_TOOL,
  PRESENT_OPTIONS_TOOL,
} from '../tools/sdk-tool-names.js';
import { names } from './support/tool-names.js';

/** Every tool the SDK names in what it tells the model. */
const SDK_TOOLS = [
  PRESENT_OPTIONS_TOOL,
  AGENT_UI_TOOLS.act,
  AGENT_UI_TOOLS.describe,
  AGENT_UI_TOOLS.read,
  AGENT_UI_TOOLS.wait,
  KNOWLEDGE_TOOL,
  LOOK_TOOL,
  CAPTURE_START_TOOL,
  CAPTURE_STATUS_TOOL,
  CAPTURE_STOP_TOOL,
  CALL_HANDOFF_TOOL,
  ATTACHMENT_LIST_TOOL,
  ATTACHMENT_VIEW_TOOL,
  ATTACHMENT_READ_TOOL,
] as const;


/** The tools of `SDK_TOOLS` that `text` names but `offered` does not offer. */
const namedButNotOffered = (text: string, offered: OfferedTools) => SDK_TOOLS.filter((tool) => !offered.has(tool) && names(text, tool));

/** Every set of the given tools: the empty set, each one alone, every pair, … all of them. */
function everySubset(tools: readonly string[]): string[][] {
  return tools.reduce<string[][]>((sets, tool) => [...sets, ...sets.map((set) => [...set, tool])], [[]]);
}

/** Every tool but one, for each: a step a policy kept from just that tool. */
const allButOne = SDK_TOOLS.map((left) => SDK_TOOLS.filter((tool) => tool !== left));

const persona: AgentPersonaConfig = {
  name: 'Desk',
  identity: 'You are Desk, the assistant of a car dealership.',
  capabilities: ['Find cars in stock', 'Book a test drive'],
  instructions: ['Answer in the customer’s language.'],
};

const RULE_TOOLS = [PRESENT_OPTIONS_TOOL, AGENT_UI_TOOLS.act, AGENT_UI_TOOLS.describe, AGENT_UI_TOOLS.read];

describe('the SDK’s rules in a host’s prompt', () => {
  const prompt = buildAgentSystemPrompt(persona, { userId: 'u1', accountId: 'a1' });

  it('name every tool they speak of when every tool is offered, as they always have', () => {
    expect(systemPromptForTools(prompt, EVERY_TOOL)).toBe(prompt);
    for (const tool of RULE_TOOLS) expect(names(prompt, tool)).toBe(true);
    expect(prompt).toContain('offer it with present_options');
    expect(prompt).toContain('### Options Presentation');
    expect(prompt).toContain('- Run an action with ui_act');
  });

  it('never name, in the rules text of a limited step, a tool the step does not offer', () => {
    for (const set of [...everySubset(RULE_TOOLS), ...allButOne, []]) {
      const offered = offeredTools(set);
      const told = systemPromptForTools(prompt, offered);
      expect(namedButNotOffered(told, offered), `offering [${set.join(', ')}]`).toEqual([]);
      // What the host wrote is all still there.
      expect(told).toContain(persona.identity);
      expect(told).toContain('Answer in the customer’s language.');
    }
  });

  it('are told to a step offering only the tool its policy allows without a word of the choice tool (the Nova case)', () => {
    const told = systemPromptForTools(prompt, offeredTools(['searchInventory']));
    expect(told).not.toContain('present_options');
    expect(told).not.toContain('### Options Presentation');
    // The rule that answers a question in words stays, without the choice that may follow it.
    expect(told).toContain('Answer from what the page and its knowledge say, in your own words. A question asked again means your last reply did not answer it');
    expect(told).not.toMatch(/\bui_(act|describe|read)\b/);
    // The UI rules still say how the page works, and never how to work it with a tool the step lacks.
    expect(told).toContain('### How actions behave');
    expect(told).not.toContain('### Working from the index');
    expect(told).toContain('- Read it: a surface\'s own read actions return its rows. Then carry on from what you read.');
  });

  it('are filtered out of a host’s prompt to exactly what the rules say for that step, from the one set of rules', () => {
    for (const set of everySubset(RULE_TOOLS)) {
      const offered = offeredTools(set);
      expect(systemPromptForTools(getToolStrategyRules(), offered)).toBe(getToolStrategyRules(offered));
      expect(systemPromptForTools(getUIControlRules(), offered)).toBe(getUIControlRules(offered));
    }
  });

  it('are each carried once, whole, by the prompt, and none holds another', () => {
    for (const rule of SDK_PROMPT_TOOL_RULES) {
      const full = fullText(rule);
      expect(prompt.split(full)).toHaveLength(2);
      for (const other of SDK_PROMPT_TOOL_RULES) if (other !== rule) expect(full.includes(fullText(other))).toBe(false);
    }
  });

  it('leave the host’s own words as they are, tool names included', () => {
    const own = buildAgentSystemPrompt({ ...persona, instructions: ['Offer test drives with present_options.'] }, { userId: 'u1', accountId: 'a1' });
    const told = systemPromptForTools(own, offeredTools([]));
    expect(told).toContain('Offer test drives with present_options.');
    expect(told).not.toContain('### Options Presentation');
  });

  it('leave a prompt with none of the SDK’s rules exactly as it is', () => {
    expect(promptForTools('You help on a dealer’s site.', SDK_PROMPT_TOOL_RULES, offeredTools([]))).toBe('You help on a dealer’s site.');
  });
});

describe('what the worker itself writes about tools', () => {
  const route = { url: 'https://api.example.com/sessions/s1', token: 'tok', expiresAt: '2030-01-01T00:00:00Z' };
  const capture: TurnCapture = {
    plans: [{ key: 'trade-in', title: 'Trade-in photos', offerWhen: 'the caller has a car to trade in' }],
    control: route,
    active: { captureId: 'cap-1', plan: 'trade-in', status: 'active', step: null },
    update: null,
    resumable: [{ captureId: 'cap-0', planKey: 'trade-in', outcome: 'partial', endedAt: null, missingSteps: ['rear'] }],
  };
  const handoff: TurnHandoff = {
    control: route,
    device: { formFactor: 'desktop', switches: 0 },
    offer: { handoffId: 'h-1', purpose: 'photos', expiresAt: '2030-01-01T00:00:00Z' },
    update: null,
  };
  const vision: TurnVision = { seeing: true, remarks: false, canLook: true, absent: null, look: route, observation: null };
  const long = 'A line of the page’s detail.\n'.repeat(900);
  const knowledge: ClientKnowledge = {
    entries: [{ title: 'Inventory', content: long }],
    workflows: [{ name: 'Book a test drive', trigger: 'they want to drive one', steps: ['Pick the car', 'Pick a time'] }],
  } as ClientKnowledge;

  /** Every line the worker writes that can name a tool, as a step offering `offered` is told it. */
  const linesFor = (offered: OfferedTools) => [
    visionText(vision, offered)!,
    captureText(capture, offered)!,
    handoffText(handoff, offered)!,
    attachmentDataNote(offered),
    renderClientKnowledge(knowledge, 2_000, offered),
    timeHandBackNote(offered),
  ];

  it('names every tool it speaks of when every tool is offered, in the words it always used', () => {
    const lines = linesFor(EVERY_TOOL).join('\n');
    for (const tool of [LOOK_TOOL, CAPTURE_START_TOOL, CAPTURE_STATUS_TOOL, CAPTURE_STOP_TOOL, CALL_HANDOFF_TOOL, ATTACHMENT_LIST_TOOL, KNOWLEDGE_TOOL, PRESENT_OPTIONS_TOOL]) {
      expect(names(lines, tool), tool).toBe(true);
    }
    expect(captureText(capture, EVERY_TOOL)).toContain(CAPTURE_WHEN);
    expect(handoffText(handoff, EVERY_TOOL)).toContain(HANDOFF_WHEN);
    expect(visionText(vision, EVERY_TOOL)).toContain(LOOK_WHEN);
    expect(attachmentDataNote(EVERY_TOOL)).toBe(ATTACHMENT_DATA_NOTE);
  });

  it('never names a tool the step does not offer', () => {
    for (const set of [[], ['searchInventory'], ...allButOne]) {
      const offered = offeredTools(set);
      expect(namedButNotOffered(linesFor(offered).join('\n'), offered), `offering [${set.join(', ')}]`).toEqual([]);
    }
  });

  it('tells a step held to other tools that it cannot do this at this step, and a later step can', () => {
    const held = offeredTools(['searchInventory']);
    expect(visionText(vision, held)).toContain('You cannot look at the caller at this step');
    expect(captureText(capture, held)).toContain('Photos cannot be started at this step.');
    expect(captureText(capture, held)).toContain('A photo capture is running now');
    expect(handoffText(handoff, held)).toContain('The call cannot be moved to another device at this step.');
    expect(attachmentDataNote(held)).toContain('<attachment> blocks of a file\'s text, and as pictures. A file\'s name');
    expect(renderClientKnowledge(knowledge, 2_000, held)).toMatch(/more characters of "Inventory" are not shown\.\)/);
    expect(timeHandBackNote(held)).toContain('say they can ask you to continue.');
    // A turn that cannot do it at all says so as it always did.
    expect(captureText({ ...capture, control: null }, held)).toContain('Photos cannot be started, checked or stopped from this turn.');
    expect(handoffText({ ...handoff, control: null }, held)).toContain('The call cannot be moved to another device from this turn.');
  });

  it('keeps the capture clause’s words when the step offers capture_start but not look, less only the look', () => {
    const told = captureText(capture, offeredTools([CAPTURE_START_TOOL, CAPTURE_STATUS_TOOL, CAPTURE_STOP_TOOL]))!;
    expect(told).toContain('You can ask the caller for photos with `capture_start` when a plan below fits. Closure’s checker accepts or rejects every photo; you never judge a photo. While a capture runs');
    expect(told).toContain('Use `capture_status` to ask where it stands');
  });
});

describe('the tools a step offers', () => {
  const turn = ['searchInventory', PRESENT_OPTIONS_TOOL, AGENT_UI_TOOLS.act, AGENT_UI_TOOLS.describe];
  const offered = (held: Parameters<typeof stepOfferedTools>[1]) => turn.filter((tool) => stepOfferedTools(turn, held).has(tool));

  it('are the turn’s tools when nothing holds the step', () => {
    expect(offered({})).toEqual(turn);
    expect(offered({ toolChoice: 'auto' })).toEqual(turn);
    expect(offered({ toolChoice: 'required' })).toEqual(turn);
  });

  it('are its active tools, of the turn’s, when the policy names them', () => {
    expect(offered({ activeTools: ['searchInventory'] })).toEqual(['searchInventory']);
    expect(offered({ activeTools: ['searchInventory', 'not_a_tool_of_the_turn'] })).toEqual(['searchInventory']);
    expect(offered({ activeTools: [] })).toEqual([]);
  });

  it('are none with toolChoice none, and the one it must call with a forced choice', () => {
    expect(offered({ toolChoice: 'none', activeTools: ['searchInventory'] })).toEqual([]);
    expect(offered({ toolChoice: { type: 'tool', toolName: AGENT_UI_TOOLS.act } })).toEqual([AGENT_UI_TOOLS.act]);
  });

  it('give one key per set, whatever the order', () => {
    expect(offeredTools(['b', 'a']).key).toBe(offeredTools(['a', 'b']).key);
    expect(offeredTools(['a']).key).not.toBe(offeredTools(['a', 'b']).key);
  });

  it('say a rule only when they offer every tool it names', () => {
    const rule = { tools: ['a', 'b'], text: 'both', otherwise: 'not both', within: [{ tools: ['c'], text: ' and c' }] };
    expect(renderRule(rule, offeredTools(['a', 'b', 'c']))).toBe('both and c');
    expect(renderRule(rule, offeredTools(['a', 'b']))).toBe('both');
    expect(renderRule(rule, offeredTools(['a', 'c']))).toBe('not both');
    expect(fullText(rule)).toBe('both and c');
  });
});
