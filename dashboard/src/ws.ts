// Module-scope WebSocket singleton + initial data bootstrap. No React lifecycle involved.
import { useStore, type EventRow, type GalleryImage, type HostList, type ScheduleItem, type Task } from './store';

const DAEMON_PORT = 8737;
const WS_URL = `ws://${location.hostname}:${DAEMON_PORT}/ws`;
let socket: WebSocket | null = null;

function connect() {
  socket = new WebSocket(WS_URL);
  socket.onopen = () => {
    socket!.send(JSON.stringify({ type: 'hello', role: 'dashboard' }));
    useStore.getState().setConnected(true);
    bootstrap();
  };
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const store = useStore.getState();
    if (msg.type === 'event') store.addEvent(msg.event as EventRow);
    else if (msg.type === 'session_state') store.setSessionState(msg.state);
    else if (msg.type === 'assistant_delta') store.appendStreaming(msg.delta);
  };
  socket.onclose = () => {
    useStore.getState().setConnected(false);
    setTimeout(connect, 1500);
  };
  socket.onerror = () => socket?.close();
}

async function bootstrap() {
  const [tasks, events, images, schedules, hosts] = await Promise.all([
    fetch('/api/tasks').then((r) => r.json() as Promise<Task[]>),
    fetch('/api/events?limit=200').then((r) => r.json() as Promise<EventRow[]>),
    fetch('/api/images').then((r) => r.json() as Promise<GalleryImage[]>),
    fetch('/api/schedule').then((r) => r.json() as Promise<ScheduleItem[]>),
    fetch('/api/hosts').then((r) => r.json() as Promise<HostList>),
  ]);
  // Merge (not replace): events that arrived live during these fetches must survive.
  useStore.getState().bootstrap(tasks, events, images, schedules);
  useStore.getState().setHosts(hosts);
}

/** Usage view data — fetched when the view opens (header toggle onClick), refetched on
 *  every open so the numbers are always fresh. No streaming, no polling. */
export async function fetchUsage() {
  try {
    const res = await fetch('/api/usage');
    if (!res.ok) throw new Error(String(res.status));
    useStore.getState().setUsage(await res.json());
  } catch {
    useStore.getState().setUsage(null, true);
  }
}

/** M7 allowlist management — POST/DELETE return the updated list, which lands in the store. */
export async function mutateHost(method: 'POST' | 'DELETE', host: string) {
  const res = await fetch('/api/hosts', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host }),
  });
  if (res.ok) useStore.getState().setHosts((await res.json()) as HostList);
}

// Shell deep-link (M3): a bubble click lands on that task's view. Module-scope hook,
// called by the Swift shell via evaluateJavaScript — same no-useEffect discipline.
declare global {
  interface Window {
    __gumboSelectTask?: (id: string) => void;
  }
}
window.__gumboSelectTask = (id: string) => useStore.getState().selectTask(id);

export function sendDebugText(text: string) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'debug_text', text }));
  }
}

export function cancelTask(taskId: string) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'task_action', task_id: taskId, action: 'cancel' }));
  }
}

connect();
