import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

process.env.GUMBO_HOME ??= mkdtempSync(join(tmpdir(), 'gumbo-test-'));
const { MAX_POINTS_PER_STROKE, MAX_STROKES, pngDimensions, sanitizeStrokes, strokeMaskPng } = await import('./mask.ts');

/** Decode the (single-IDAT, filter-None) mask PNG and read one pixel's alpha. */
function alphaAt(png: Buffer, width: number, x: number, y: number): number {
  let off = 8;
  let idat = Buffer.alloc(0);
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat = Buffer.concat([idat, png.subarray(off + 8, off + 8 + len)]);
    off += 12 + len;
  }
  const raw = inflateSync(idat);
  const stride = 1 + width * 4;
  return raw[y * stride + 1 + x * 4 + 3];
}

test('a stroke rasterizes as a transparent capsule: on-path clear, round caps, elsewhere opaque', () => {
  // 200×100, horizontal stroke across the middle, radius 5 % of width = 10 px.
  const png = strokeMaskPng(200, 100, [{ points: [[0.2, 0.5], [0.8, 0.5]], radius: 0.05 }]);
  assert.deepEqual(pngDimensions(png), { width: 200, height: 100 });
  assert.equal(alphaAt(png, 200, 100, 50), 0, 'mid-path pixel is transparent (edit region)');
  assert.equal(alphaAt(png, 200, 100, 45), 0, 'within radius above the path');
  assert.equal(alphaAt(png, 200, 35, 50), 0, 'round cap extends past the endpoint');
  assert.equal(alphaAt(png, 200, 10, 50), 255, 'beyond the cap is preserved');
  assert.equal(alphaAt(png, 200, 100, 80), 255, 'far from the path is preserved');
  assert.equal(alphaAt(png, 200, 0, 0), 255, 'corner is preserved');
});

test('a single-point stroke is a tap — a stamped circle', () => {
  const png = strokeMaskPng(100, 100, [{ points: [[0.5, 0.5]], radius: 0.1 }]);
  assert.equal(alphaAt(png, 100, 50, 50), 0);
  assert.equal(alphaAt(png, 100, 50, 42), 0, 'inside the circle');
  assert.equal(alphaAt(png, 100, 50, 35), 255, 'outside the circle');
});

test('no strokes → fully opaque (nothing marked for editing)', () => {
  const png = strokeMaskPng(40, 30, []);
  assert.equal(alphaAt(png, 40, 20, 15), 255);
  assert.equal(alphaAt(png, 40, 0, 0), 255);
});

test('sanitizeStrokes: cleans a valid payload, clamps coords and radius', () => {
  const [s] = sanitizeStrokes([{ points: [[-0.5, 0.4], [1.7, 0.6]], radius: 9 }]);
  assert.deepEqual(s.points, [[0, 0.4], [1, 0.6]]);
  assert.ok(s.radius <= 0.25, 'radius clamped to the maximum');
});

test('sanitizeStrokes: rejects malformed payloads off the wire', () => {
  assert.throws(() => sanitizeStrokes('nope'), /must be an array/);
  assert.throws(() => sanitizeStrokes([{ points: [], radius: 0.05 }]), /needs points/);
  assert.throws(() => sanitizeStrokes([{ points: [['a', 'b']], radius: 0.05 }]), /numeric pairs/);
  assert.throws(() => sanitizeStrokes([{ points: [[0, 0]], radius: 'wide' }]), /numeric radius/);
});

test('sanitizeStrokes: over-LIMIT sizes are clamped, never rejected (review 🔴 — a throw would disarm the context / hang the viewer)', () => {
  const flood = Array.from({ length: MAX_STROKES + 50 }, () => ({ points: [[0, 0]] as Array<[number, number]>, radius: 0.05 }));
  assert.equal(sanitizeStrokes(flood).length, MAX_STROKES);
  const longStroke = [{ points: Array.from({ length: MAX_POINTS_PER_STROKE + 500 }, (_, i) => [i / 3000, 0.5] as [number, number]), radius: 0.05 }];
  assert.equal(sanitizeStrokes(longStroke)[0].points.length, MAX_POINTS_PER_STROKE);
});

test('pngDimensions rejects non-PNG bytes', () => {
  assert.throws(() => pngDimensions(Buffer.from('definitely not a png, sorry')), /not a PNG/);
});
