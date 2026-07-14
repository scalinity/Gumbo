// Module-scope WebSocket singleton + initial data bootstrap. No React lifecycle involved.
import { useStore, type EventRow, type Task } from './store';

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
  const [tasks, events] = await Promise.all([
    fetch('/api/tasks').then((r) => r.json() as Promise<Task[]>),
    fetch('/api/events?limit=200').then((r) => r.json() as Promise<EventRow[]>),
  ]);
  // Merge (not replace): events that arrived live during these fetches must survive.
  useStore.getState().bootstrap(tasks, events);
}

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
