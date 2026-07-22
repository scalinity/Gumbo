import { create } from 'zustand';
import type { Granularity, Metric, UsageDayRow } from './rollup';

export interface EventRow {
  seq: number;
  ts: number;
  task_id: string | null;
  type: string;
  payload: Record<string, unknown> | null;
}

export interface Task {
  id: string;
  kind: string;
  title: string;
  status: 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled';
  created_at: number;
}

export type SessionState = 'idle' | 'listening' | 'thinking' | 'speaking';

// M5: one gallery entry per generated image — filenames only, bytes stream from
// /files/images/<file> on render.
export interface GalleryImage {
  file: string;
  ts: number;
}

// M5: a scheduler row (kind is 'reminder' for now — the daemon keeps the seam general).
export interface ScheduleItem {
  id: string;
  fire_at: number;
  kind: string;
  text: string;
  status: 'pending' | 'fired' | 'cancelled';
}

// M7: the computer-use host allowlist (browser lane + script-lane URL gate). base is
// config-owned (read-only here); remembered is managed via /api/hosts.
export interface HostList {
  base: string[];
  remembered: string[];
}

interface GumboStore {
  connected: boolean;
  sessionState: SessionState;
  events: EventRow[];
  tasks: Task[];
  images: GalleryImage[];
  schedules: ScheduleItem[];
  hosts: HostList;
  streamingText: string;
  /** The same streamed reply as arrival-ordered chunks: each mounts once in the UI, so
   *  the token fade-in plays per chunk and never replays on earlier text. */
  streamingChunks: string[];
  selectedTaskId: string | null;
  // Usage view (fetched on open, not streamed — see ws.ts fetchUsage).
  view: 'feed' | 'usage';
  usage: UsageDayRow[] | null; // null = not fetched yet
  usageError: boolean;
  granularity: Granularity;
  usageMetric: Metric;
  includeCredits: boolean; // Tavily/Exa/Firecrawl est. $ — free tiers, so off by default
  setConnected: (connected: boolean) => void;
  setSessionState: (state: SessionState) => void;
  bootstrap: (tasks: Task[], events: EventRow[], images: GalleryImage[], schedules: ScheduleItem[]) => void;
  setHosts: (hosts: HostList) => void;
  addEvent: (event: EventRow) => void;
  appendStreaming: (delta: string) => void;
  selectTask: (id: string | null) => void;
  setView: (view: 'feed' | 'usage') => void;
  setUsage: (rows: UsageDayRow[] | null, error?: boolean) => void;
  setGranularity: (granularity: Granularity) => void;
  setUsageMetric: (metric: Metric) => void;
  toggleCredits: () => void;
}

const TASK_CAP = 200;
const EVENT_CAP = 500;
const IMAGE_CAP = 100;
const SCHEDULE_CAP = 100;

// Same shape the daemon's /api/schedule uses: upcoming soonest-first, then past newest-first.
function sortSchedules(rows: ScheduleItem[]): ScheduleItem[] {
  return [...rows].sort((a, b) => {
    const ap = a.status === 'pending' ? 0 : 1;
    const bp = b.status === 'pending' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return ap === 0 ? a.fire_at - b.fire_at : b.fire_at - a.fire_at;
  });
}

// Merge a server snapshot with whatever already arrived live, deduped by key, so events
// delivered during the bootstrap fetch window aren't dropped by a blind replace.
function mergeBy<T>(snapshot: T[], live: T[], key: (item: T) => string | number): T[] {
  const byKey = new Map<string | number, T>();
  for (const item of snapshot) byKey.set(key(item), item);
  for (const item of live) byKey.set(key(item), item); // live wins on conflict (it's newer)
  return [...byKey.values()];
}

export const useStore = create<GumboStore>((set) => ({
  connected: false,
  sessionState: 'idle',
  events: [],
  tasks: [],
  images: [],
  schedules: [],
  hosts: { base: [], remembered: [] },
  streamingText: '',
  streamingChunks: [],
  selectedTaskId: null,
  view: 'feed',
  usage: null,
  usageError: false,
  granularity: 'day',
  usageMetric: 'cost',
  includeCredits: false,
  setConnected: (connected) => set({ connected }),
  setSessionState: (sessionState) => set({ sessionState }),
  setHosts: (hosts) => set({ hosts }),
  bootstrap: (tasks, events, images, schedules) =>
    set((s) => ({
      tasks: mergeBy([...tasks, ...s.tasks], [], (t) => t.id).slice(0, TASK_CAP),
      events: mergeBy(events, s.events, (e) => e.seq)
        .sort((a, b) => a.seq - b.seq)
        .slice(-EVENT_CAP),
      images: mergeBy(images, s.images, (i) => i.file)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, IMAGE_CAP),
      schedules: sortSchedules(mergeBy(schedules, s.schedules, (r) => r.id)).slice(0, SCHEDULE_CAP),
    })),
  addEvent: (event) =>
    set((s) => {
      const events = [...s.events.slice(-(EVENT_CAP - 1)), event];
      let tasks = s.tasks;
      let images = s.images;
      let schedules = s.schedules;
      let streamingText = s.streamingText;
      let streamingChunks = s.streamingChunks;
      if (event.type === 'image.created') {
        // Filename only — the daemon keeps base64 off the event stream by contract.
        const file = String(event.payload?.file ?? '');
        if (file && !images.some((i) => i.file === file)) {
          images = [{ file, ts: event.ts }, ...images].slice(0, IMAGE_CAP);
        }
      } else if (event.type === 'reminder.set') {
        const item: ScheduleItem = {
          id: String(event.payload?.id ?? ''),
          fire_at: Number(event.payload?.fire_at ?? event.ts),
          kind: String(event.payload?.kind ?? 'reminder'),
          text: String(event.payload?.text ?? ''),
          status: 'pending',
        };
        if (item.id) schedules = sortSchedules([item, ...schedules.filter((r) => r.id !== item.id)]).slice(0, SCHEDULE_CAP);
      } else if (event.type === 'reminder.fired' || event.type === 'reminder.cancelled') {
        const status = event.type === 'reminder.fired' ? 'fired' : 'cancelled';
        schedules = sortSchedules(schedules.map((r) => (r.id === event.payload?.id ? { ...r, status } : r)));
      } else if (event.type === 'task.created' && event.task_id) {
        const created: Task = {
          id: event.task_id,
          kind: String(event.payload?.kind ?? 'subagent'),
          title: String(event.payload?.title ?? event.task_id),
          status: 'running',
          created_at: event.ts,
        };
        tasks = [created, ...tasks].slice(0, TASK_CAP);
      } else if (event.type === 'task.finished' && event.task_id) {
        tasks = tasks.map((t) =>
          t.id === event.task_id ? { ...t, status: (event.payload?.status ?? 'done') as Task['status'] } : t,
        );
      } else if (event.type === 'task.status' && event.task_id) {
        // M4: mid-run needs_input ⇄ running flips (notch confirm pending, cap hit, resume).
        tasks = tasks.map((t) =>
          t.id === event.task_id ? { ...t, status: (event.payload?.status ?? t.status) as Task['status'] } : t,
        );
      } else if (event.type === 'transcript.assistant') {
        streamingText = '';
        streamingChunks = [];
      }
      return { events, tasks, images, schedules, streamingText, streamingChunks };
    }),
  appendStreaming: (delta) =>
    set((s) => ({ streamingText: s.streamingText + delta, streamingChunks: [...s.streamingChunks, delta] })),
  selectTask: (id) => set({ selectedTaskId: id }),
  setView: (view) => set({ view }),
  setUsage: (usage, error = false) => set({ usage, usageError: error }),
  setGranularity: (granularity) => set({ granularity }),
  setUsageMetric: (usageMetric) => set({ usageMetric }),
  toggleCredits: () => set((s) => ({ includeCredits: !s.includeCredits })),
}));
