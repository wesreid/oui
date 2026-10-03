/**
 * Live eval: does the model see a picture an action answers with (ADR-0244
 * §2.2, ADR-0245 §2.4)?
 *
 * The page offers a snapshot reader that answers with `data.image`, a PNG the
 * test draws itself: a board split into a left and a right half of two plain
 * colours. Nothing else on the page says what the colours are, so the model
 * can only answer from the picture. It is given the picture as an image part
 * of the tool result, through the worker and the live provider.
 *
 * Run: `pnpm --filter @ouispec/agent-worker eval:live` with Bedrock
 * credentials. `EVAL_MODEL_ID` sets the model, `EVAL_RUNS` the runs, and
 * `EVAL_TEMPERATURE=none` sends no temperature.
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { LIVE_MODEL_ID, livePage, liveTurn } from './support/live-page.js';

const RUNS = Number(process.env.EVAL_RUNS ?? 3);

// ─── A PNG, drawn here ───────────────────────────────────────────────────────

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
type RGB = [number, number, number];
/** A PNG whose left half is one colour and whose right half is another. */
function halves(width: number, height: number, left: RGB, right: RGB): string {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) raw.set(x < width / 2 ? left : right, row + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits a channel, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]).toString('base64');
}

const BOARDS: Array<{ left: [string, RGB]; right: [string, RGB] }> = [
  { left: ['red', [220, 30, 30]], right: ['blue', [30, 60, 220]] },
  { left: ['green', [30, 170, 60]], right: ['yellow', [245, 220, 30]] },
  { left: ['blue', [30, 60, 220]], right: ['red', [220, 30, 30]] },
];

function board(left: RGB, right: RGB) {
  return livePage([
    {
      id: 'room:board',
      name: 'Board',
      description: 'An artboard.',
      observations: () => ({ artboard: { id: 'ab-1', width: 320, height: 180 } }),
      actions: [
        {
          id: 'board_snapshot',
          title: 'Snapshot',
          description: 'A picture of the artboard as it is drawn now.',
          effect: 'view',
          input: { type: 'object', additionalProperties: false, properties: {} },
          run: () => ({
            success: true,
            data: { image: { mediaType: 'image/png', base64: halves(320, 180, left, right), width: 320, height: 180 }, artboardId: 'ab-1' },
          }),
        },
      ],
    },
  ]);
}

describe(`the model sees a picture an action answers with (${LIVE_MODEL_ID}, ${RUNS} runs)`, () => {
  for (let run = 1; run <= RUNS; run++) {
    const { left, right } = BOARDS[(run - 1) % BOARDS.length];
    it(`says which colour is on which side of the board (run ${run}: ${left[0]} | ${right[0]})`, async () => {
      const page = board(left[1], right[1]);
      const turn = await liveTurn(page, 'Look at the artboard. What colour is its left half, and what colour is its right half?', { maxRounds: 4 });
      console.log(JSON.stringify({ eval: 'ui-answer-image', model: LIVE_MODEL_ID, run, calls: turn.calls, reply: turn.reply.slice(0, 240), peakPromptTokens: turn.usage.peakPromptTokens }));
      expect(page.ran.map((r) => r.action)).toContain('board_snapshot');
      const reply = turn.reply.toLowerCase();
      // Each side is named with its own colour: the left one before the right one.
      expect(reply).toMatch(new RegExp(`left[^.]*\\b${left[0]}\\b`));
      expect(reply).toMatch(new RegExp(`right[^.]*\\b${right[0]}\\b`));
      // The picture went as a picture: its base64 as text would be far more.
      expect(turn.usage.peakPromptTokens).toBeLessThan(20_000);
    }, 180_000);
  }
});
