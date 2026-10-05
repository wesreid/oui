/**
 * A room action whose work outlives its call (a picture made from a prompt, an
 * export) takes the same path as a job control: its run returns at once with
 * the job's id, the page answers "started" at once, and the final answer comes
 * when the job's declared completion arrives through the app's job tracker.
 * Nothing waits for the job inside the call: an assistant's turn is never held
 * open by it, and can stop it or start something else meanwhile.
 *
 * Over a socket, as a tab answers the assistant's worker: first answer and
 * final answer are both what the tab sends.
 */
import { act } from '@testing-library/react';
import { createSurfaceRuntime } from 'oui-spec/core';
import type { SocketLike } from 'oui-spec';
import { PLATFORM_EVENTS, createEventCatalog, type EventDeclarationDocument } from '@ouispec/agent-events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBindingRegistry, type OuiManifest } from '../src/index.js';
import { connectBindings, createDeclaredJobTracker } from '../src/oui.js';

const studioEvents: EventDeclarationDocument = {
  version: 1,
  product: 'studio',
  rooms: { picture: { pattern: 'picture:{pictureId}' } },
  events: {
    'picture:ready': {
      description: 'A picture was made.',
      payload: {
        type: 'object',
        properties: { pictureId: { type: 'string' }, layerId: { type: 'string' } },
        required: ['pictureId'],
      },
      rooms: ['picture'],
      correlation: ['pictureId'],
      role: 'completion',
      completes: 'picture',
      result: ['layerId'],
    },
    'picture:failed': {
      description: 'A picture could not be made.',
      payload: { type: 'object', properties: { pictureId: { type: 'string' }, error: { type: 'string' } }, required: ['pictureId'] },
      rooms: ['picture'],
      correlation: ['pictureId'],
      role: 'failure',
      completes: 'picture',
      reason: { field: 'error', fallback: 'The picture could not be made' },
    },
  },
};

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'room:vector-studio',
      kind: 'room',
      title: 'Vector studio',
      description: 'Graphics',
      routes: ['/vector'],
      actions: [
        {
          name: 'vector_studio_generate_picture',
          id: 'vector-studio/action/generate-picture',
          source: 'room-action',
          title: 'Generate a picture',
          description: 'Make a picture from a prompt and place it',
          input: { type: 'object', properties: { prompt: { type: 'string' } } },
          // A picture can wait behind a live conversation: 16 min.
          effect: { kind: 'job', estimatedDuration: '10–60 s', timeoutMs: 960_000 },
          reach: [],
        },
      ],
      observations: [],
    },
  ],
};

/** The tab's socket: requests arrive on it, answers leave on it, and the job's events arrive on it. */
function tabSocket() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const sent: Array<{ event: string; data: Record<string, unknown> }> = [];
  const socket: SocketLike = {
    connected: true,
    emit: (event: string, data: unknown) => void sent.push({ event, data: data as Record<string, unknown> }),
    on: (event: string, handler: (data: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (data: unknown) => void) => void handlers.get(event)?.delete(handler),
    once: () => {},
  };
  const receive = (event: string, data: unknown) => handlers.get(event)?.forEach((h) => h(data));
  const joined: string[] = [];
  const source = {
    subscribe: (rooms: string[]) => void joined.push(...rooms),
    unsubscribe: () => {},
    on: (event: string, handler: (data: unknown) => void) => socket.on(event, handler),
  };
  const answers = () => sent.filter((s) => s.event === 'oui:action:result').map((s) => s.data);
  return { socket, receive, source, joined, answers };
}

let disconnect: (() => void) | null = null;
afterEach(() => {
  disconnect?.();
  disconnect = null;
  vi.useRealTimers();
});

describe('a room action that starts a job', () => {
  it('answers started within one tick, and its final answer arrives on the job’s declared event', async () => {
    vi.useFakeTimers();
    const tab = tabSocket();
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
    const jobs = createDeclaredJobTracker({ events: createEventCatalog(PLATFORM_EVENTS, studioEvents), source: tab.source, kind: 'picture' });
    disconnect = connectBindings({ registry, runtime, manifest, jobs });
    const run = vi.fn(async () => ({ ok: true as const, data: { prompt: 'a red fox' }, pending: { jobId: 'pic-1' } }));
    registry.registerRoom({
      catalog: {
        room: 'vector-studio',
        title: 'Vector studio',
        description: 'Graphics',
        actions: [
          {
            kind: 'action',
            id: 'generate-picture',
            title: 'Generate a picture',
            description: 'Make a picture from a prompt and place it',
            control: 'Generate',
            input: { type: 'object' },
            effect: { kind: 'job' },
          },
        ],
        fields: [],
        commands: [],
        observations: [],
      },
      run,
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    runtime.attach(tab.socket);

    tab.receive('oui:dispatch', {
      requestId: 'call-gen',
      surfaceId: 'room:vector-studio',
      actionId: 'vector_studio_generate_picture',
      params: { prompt: 'a red fox' },
      timestamp: 0,
    });
    // One tick: the run returned the job's id and the page answered started.
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(run).toHaveBeenCalledTimes(1);
    expect(tab.answers()).toEqual([
      expect.objectContaining({ requestId: 'call-gen', success: true, interim: true, data: { status: 'started', jobId: 'pic-1' } }),
    ]);
    // Followed in the room the declared completion names for one job.
    expect(tab.joined).toEqual(['picture:pic-1']);

    // A minute passes: no final answer, and nothing gives up on the job, whose limit is 16 min.
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(tab.answers()).toHaveLength(1);

    tab.receive('picture:ready', { pictureId: 'pic-1', layerId: 'layer-9' });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(tab.answers()).toHaveLength(2);
    expect(tab.answers()[1]).toMatchObject({
      requestId: 'call-gen',
      success: true,
      interim: false,
      data: { status: 'complete', jobId: 'pic-1', layerId: 'layer-9' },
    });
  });

  it('answers a failed job as a failure, with the declared reason as its error and the outcome kept', async () => {
    vi.useFakeTimers();
    const tab = tabSocket();
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
    const jobs = createDeclaredJobTracker({ events: createEventCatalog(PLATFORM_EVENTS, studioEvents), source: tab.source, kind: 'picture' });
    disconnect = connectBindings({ registry, runtime, manifest, jobs });
    registry.registerRoom({
      catalog: {
        room: 'vector-studio',
        title: 'Vector studio',
        description: 'Graphics',
        actions: [
          { kind: 'action', id: 'generate-picture', title: 'Generate a picture', description: 'Make a picture', control: 'Generate', input: { type: 'object' }, effect: { kind: 'job' } },
        ],
        fields: [],
        commands: [],
        observations: [],
      },
      run: async () => ({ ok: true as const, pending: { jobId: 'pic-2' } }),
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    runtime.attach(tab.socket);
    tab.receive('oui:dispatch', { requestId: 'call-2', surfaceId: 'room:vector-studio', actionId: 'vector_studio_generate_picture', params: {}, timestamp: 0 });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(tab.answers()).toEqual([expect.objectContaining({ interim: true })]);

    tab.receive('picture:failed', { pictureId: 'pic-2', error: 'Cancelled by the person' });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(tab.answers()[1]).toMatchObject({
      requestId: 'call-2',
      success: false,
      interim: false,
      error: { code: 'JOB_FAILED', message: 'Cancelled by the person' },
      data: { status: 'failed', jobId: 'pic-2', error: 'Cancelled by the person' },
    });
  });
});
