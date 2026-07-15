// One-shot TTS for cold completion announcements (SPEC §9 M3): a task finished with no
// live realtime session, and we never open one just to announce. /v1/audio/speech with
// response_format 'pcm' returns 24 kHz mono pcm16 — the shell's exact wire format — so
// chunks stream straight out as 0x02 binary frames with no transcoding.
import { config } from '../config.ts';
import type { TaskRow } from '../events/store.ts';
import type { Hub } from '../ws/hub.ts';
import { AUDIO_TTS } from '../ws/protocol.ts';

const TTS_HEADER = Buffer.from([AUDIO_TTS]);

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
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`tts ${res.status}: ${detail.slice(0, 200)}`);
  }
  // Forward chunks as they arrive (announcement starts before synthesis finishes). An
  // HTTP chunk can split a 16-bit sample; carry the odd byte so no frame boundary can
  // byte-shift the remainder of the stream into noise.
  let carry: Buffer | null = null;
  for await (const chunk of res.body) {
    let buf: Buffer = carry ? Buffer.concat([carry, Buffer.from(chunk)]) : Buffer.from(chunk);
    carry = null;
    if (buf.byteLength % 2 === 1) {
      carry = buf.subarray(buf.byteLength - 1);
      buf = buf.subarray(0, buf.byteLength - 1);
    }
    if (buf.byteLength > 0) hub.sendBinary(Buffer.concat([TTS_HEADER, buf]), 'shell');
  }
}
