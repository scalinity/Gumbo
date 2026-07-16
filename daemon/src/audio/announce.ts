// One-shot TTS for cold completion announcements (SPEC §9 M3): a task finished with no
// live realtime session, and we never open one just to announce. /v1/audio/speech with
// response_format 'pcm' returns 24 kHz mono pcm16 — the shell's exact wire format — so
// chunks stream straight out as 0x02 binary frames with no transcoding.
import { config } from '../config.ts';
import type { TaskRow } from '../events/store.ts';
import type { Hub } from '../ws/hub.ts';
import { AUDIO_TTS } from '../ws/protocol.ts';

const TTS_HEADER = Buffer.from([AUDIO_TTS]);

// Deliberately announce-only (unlike the live path, which delivers the report's key
// finding): with no session open, the user may be away or mid-something — reading a full
// report aloud unprompted is worse than a one-line notice he can follow up on.
export function announcementText(task: TaskRow): string {
  switch (task.status) {
    case 'done':
      return `the user, your sub-agent finished the ${task.title} task.`;
    case 'failed':
      return `the user, heads up — the ${task.title} task failed.`;
    case 'cancelled':
      return `the user, the ${task.title} task was cancelled.`;
    default:
      return `the user, the ${task.title} task is now ${task.status}.`;
  }
}

// Announcements are serialized: two tasks finishing together must not interleave their
// 0x02 frames into one garbled stream at the shell's single player.
let queue: Promise<void> = Promise.resolve();

export function speakAnnouncement(hub: Hub, text: string): Promise<void> {
  const run = queue.then(() => synthesize(hub, text));
  queue = run.catch(() => {}); // a failed announcement must not wedge the queue
  return run;
}

async function synthesize(hub: Hub, text: string): Promise<void> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.models.tts,
      voice: config.voice, // same voice as the realtime session
      input: text,
      response_format: 'pcm',
    }),
    // A hung request must not wedge the serialized queue for undici's multi-minute
    // defaults — later announcements wait behind this one.
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`tts ${res.status}: ${detail.slice(0, 200)}`);
  }
  // Forward chunks as they arrive (announcement starts before synthesis finishes).
  let carry: Buffer | null = null;
  for await (const chunk of res.body) {
    const aligned = alignPcm16(Buffer.from(chunk), carry);
    carry = aligned.carry;
    if (aligned.frame.byteLength > 0) {
      hub.sendBinary(Buffer.concat([TTS_HEADER, aligned.frame]), 'shell');
    }
  }
}

/**
 * Split a byte stream into pcm16-sample-aligned frames: an HTTP chunk can split a 16-bit
 * sample, and an odd-length frame would byte-shift the remainder of the stream into
 * noise. Returns the even-length frame to send now and the carried odd byte (copied —
 * incoming chunk memory may be pooled) to prepend to the next chunk. Pure; unit-tested.
 */
export function alignPcm16(chunk: Buffer, carry: Buffer | null): { frame: Buffer; carry: Buffer | null } {
  let frame = carry ? Buffer.concat([carry, chunk]) : chunk;
  let nextCarry: Buffer | null = null;
  if (frame.byteLength % 2 === 1) {
    nextCarry = Buffer.from(frame.subarray(frame.byteLength - 1));
    frame = frame.subarray(0, frame.byteLength - 1);
  }
  return { frame, carry: nextCarry };
}
