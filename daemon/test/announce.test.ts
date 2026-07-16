// Run: npx tsx --test daemon/test/announce.test.ts  (node:test, no extra deps)
// Covers the pcm16 alignment invariant: every emitted frame is even-length and the
// reassembled stream is byte-exact regardless of how HTTP chunking splits samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignPcm16 } from '../src/audio/announce.ts';

function run(chunks: Buffer[]): { frames: Buffer[]; carry: Buffer | null } {
  const frames: Buffer[] = [];
  let carry: Buffer | null = null;
  for (const chunk of chunks) {
    const out = alignPcm16(chunk, carry);
    carry = out.carry;
    if (out.frame.byteLength > 0) frames.push(out.frame);
  }
  return { frames, carry };
}

test('even chunk passes through with no carry', () => {
  const { frames, carry } = run([Buffer.from([1, 2, 3, 4])]);
  assert.equal(carry, null);
  assert.deepEqual(Buffer.concat(frames), Buffer.from([1, 2, 3, 4]));
});

test('odd chunk emits even frame and carries the last byte', () => {
  const { frames, carry } = run([Buffer.from([1, 2, 3])]);
  assert.deepEqual(Buffer.concat(frames), Buffer.from([1, 2]));
  assert.deepEqual(carry, Buffer.from([3]));
});

test('carry joins the next chunk in order', () => {
  const { frames, carry } = run([Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])]);
  assert.equal(carry, null);
  assert.deepEqual(Buffer.concat(frames), Buffer.from([1, 2, 3, 4, 5, 6]));
});

test('alternating odd chunks stay aligned', () => {
  const { frames, carry } = run([Buffer.from([1]), Buffer.from([2]), Buffer.from([3])]);
  assert.deepEqual(Buffer.concat(frames), Buffer.from([1, 2]));
  assert.deepEqual(carry, Buffer.from([3]));
  for (const frame of frames) assert.equal(frame.byteLength % 2, 0);
});

test('empty chunk is a no-op that preserves the carry', () => {
  const first = alignPcm16(Buffer.from([9]), null);
  const second = alignPcm16(Buffer.alloc(0), first.carry);
  assert.equal(second.frame.byteLength, 0);
  assert.deepEqual(second.carry, Buffer.from([9]));
});

test('byte-exact reassembly across every split point of a stream', () => {
  const stream = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  for (let split = 0; split <= stream.byteLength; split++) {
    const { frames, carry } = run([stream.subarray(0, split), stream.subarray(split)]);
    const reassembled = carry
      ? Buffer.concat([Buffer.concat(frames), carry])
      : Buffer.concat(frames);
    assert.deepEqual(reassembled, stream, `split at ${split}`);
    for (const frame of frames) assert.equal(frame.byteLength % 2, 0, `odd frame at split ${split}`);
  }
});

test('carry survives even when the source chunk buffer is reused (pooled memory)', () => {
  const pooled = Buffer.from([7, 8, 9]);
  const out = alignPcm16(pooled, null);
  pooled.fill(0); // simulate the pool reusing the chunk's memory
  assert.deepEqual(out.carry, Buffer.from([9]));
});
