import { create } from 'zustand';

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

interface GumboStore {
  connected: boolean;
  sessionState: SessionState;
  events: EventRow[];
  tasks: Task[];
  streamingText: string;
  selectedTaskId: string | null;
  setConnected: (connected: boolean) => void;
  setSessionState: (state: SessionState) => void;
  bootstrap: (tasks: Task[], events: EventRow[]) => void;
  addEvent: (event: EventRow) => void;
  appendStreaming: (delta: string) => void;
  selectTask: (id: string | null) => void;
}

const TASK_CAP = 200;
const EVENT_CAP = 500;

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
  streamingText: '',
  selectedTaskId: null,
  setConnected: (connected) => set({ connected }),
  setSessionState: (sessionState) => set({ sessionState }),
  bootstrap: (tasks, events) =>
    set((s) => ({
      tasks: mergeBy([...tasks, ...s.tasks], [], (t) => t.id).slice(0, TASK_CAP),
      events: mergeBy(events, s.events, (e) => e.seq)
        .sort((a, b) => a.seq - b.seq)
        .slice(-EVENT_CAP),
    })),
  addEvent: (event) =>
    set((s) => {
      const events = [...s.events.slice(-(EVENT_CAP - 1)), event];
      let tasks = s.tasks;
      let streamingText = s.streamingText;
      if (event.type === 'task.created' && event.task_id) {
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
      } else if (event.type === 'transcript.assistant') {
        streamingText = '';
      }
      return { events, tasks, streamingText };
    }),
  appendStreaming: (delta) => set((s) => ({ streamingText: s.streamingText + delta })),
  selectTask: (id) => set({ selectedTaskId: id }),
}));
