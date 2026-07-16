// Brush-selection → inpainting mask, encoded as PNG with zero dependencies (node:zlib
// only). The OpenAI edits contract: TRANSPARENT pixels mark the region to edit; opaque
// pixels are preserved. The shell sends brush STROKES (normalized polylines + radius —
// tiny JSON, no binary upload); the daemon rasterizes them at the source image's exact
// pixel size — masks must match the image dimensions, and rasterizing here keeps the
// mask format under our control and unit-tested. The shell draws the same round-capped
// strokes as its highlight overlay, so what the user sees IS what the API masks.
import { deflateSync } from 'node:zlib';

/** One brush stroke: points normalized 0–1 (origin top-left), radius normalized to
 *  image WIDTH. A single-point stroke is a tap (stamped circle). */
export interface Stroke {
  points: Array<[number, number]>;
  radius: number;
}

// Guards against a runaway/hostile payload — generous for any real hand-drawn selection.
export const MAX_STROKES = 200;
export const MAX_POINTS_PER_STROKE = 2000;
const MIN_RADIUS = 0.002; // 0.2 % of width — thinner would rasterize to nothing useful
const MAX_RADIUS = 0.25;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Standard CRC-32 (PNG chunk checksums), table-based.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/** Read a PNG's pixel dimensions from its IHDR (bytes 16–24 of any valid PNG). */
export function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Shape-check strokes off the wire; returns a cleaned copy or throws. */
export function sanitizeStrokes(input: unknown): Stroke[] {
  if (!Array.isArray(input)) throw new Error('strokes must be an array');
  if (input.length > MAX_STROKES) throw new Error(`too many strokes (max ${MAX_STROKES})`);
  return input.map((s) => {
    const stroke = s as { points?: unknown; radius?: unknown };
    if (!Array.isArray(stroke.points) || stroke.points.length === 0) throw new Error('stroke needs points');
    if (stroke.points.length > MAX_POINTS_PER_STROKE) throw new Error(`stroke too long (max ${MAX_POINTS_PER_STROKE} points)`);
    const radius = Number(stroke.radius);
    if (!Number.isFinite(radius)) throw new Error('stroke needs a numeric radius');
    return {
      radius: Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius)),
      points: stroke.points.map((p) => {
        const [x, y] = p as [unknown, unknown];
        const px = Number(x);
        const py = Number(y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('stroke points must be numeric pairs');
        return [Math.min(1, Math.max(0, px)), Math.min(1, Math.max(0, py))] as [number, number];
      }),
    };
  });
}

/**
 * Rasterize round-capped strokes into a width×height RGBA mask PNG: alpha 0
 * (transparent → "edit this") anywhere a stroke covers, alpha 255 (preserve)
 * everywhere else. Each segment is a capsule — distance-to-segment ≤ radius —
 * evaluated only inside the segment's bounding box, so cost tracks the painted
 * area, not the whole image.
 */
export function strokeMaskPng(width: number, height: number, strokes: Stroke[]): Buffer {
  // alpha[y*width + x]: start fully opaque, strokes punch transparency.
  const alpha = new Uint8Array(width * height).fill(255);

  for (const stroke of strokes) {
    const r = stroke.radius * width;
    const pts = stroke.points.map(([nx, ny]) => [nx * width, ny * height] as const);
    // A tap is a zero-length segment — the loop below handles it via p0 === p1.
    const segments = pts.length === 1 ? [[pts[0], pts[0]] as const] : pts.slice(1).map((p, i) => [pts[i], p] as const);
    for (const [[ax, ay], [bx, by]] of segments) {
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
      const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
      const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r));
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      const rSq = r * r;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          // Distance from pixel center to the segment (t clamped to [0,1]).
          const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lenSq));
          const ex = x - (ax + t * dx);
          const ey = y - (ay + t * dy);
          if (ex * ex + ey * ey <= rSq) alpha[y * width + x] = 0;
        }
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  // compression / filter / interlace all 0

  // Raw scanlines: 1 filter byte (0 = None) + width RGBA pixels. Only alpha varies.
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 4 + 3] = alpha[y * width + x];
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
