import { memo, useRef, useState } from 'react';
import { useStore, type EventRow } from './store';
import { sendDebugText, cancelTask, mutateHost } from './ws';

function stamp(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

// M5: reminder fire times read like a person would say them.
function fireLabel(ts: number) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function Simmer() {
  const state = useStore((s) => s.sessionState);
  return (
    <div className="simmer" data-state={state} aria-label={`session ${state}`}>
      <span /><span /><span /><span /><span />
    </div>
  );
}

function Header() {
  const state = useStore((s) => s.sessionState);
  const connected = useStore((s) => s.connected);
  return (
    <header className="header">
      <div className="wordmark">Gumbo</div>
      <Simmer />
      <div className="session-label">{state}</div>
      <div className="conn" data-ok={connected}>{connected ? 'daemon connected' : 'daemon offline — retrying'}</div>
    </header>
  );
}

function TasksSection() {
  const tasks = useStore((s) => s.tasks);
  const selected = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);
  return (
    <>
      <div className="rail-heading">Background tasks</div>
      {tasks.length === 0 && <div className="rail-empty">Nothing simmering yet. Ask Gumbo to start something.</div>}
      {tasks.map((t) => (
        <div key={t.id} className="task-row" data-selected={selected === t.id}>
          <button
            className="task-open"
            onClick={() => selectTask(selected === t.id ? null : t.id)}
          >
            <span className="task-dot" data-status={t.status} />
            <span className="task-title">{t.title}</span>
            <span className="task-id">{t.id}</span>
          </button>
          {(t.status === 'running' || t.status === 'needs_input') && (
            <button className="task-cancel" title="Cancel task" onClick={() => cancelTask(t.id)}>
              stop
            </button>
          )}
        </div>
      ))}
    </>
  );
}

// M5: upcoming reminders first (gold, pulsing), then fired/cancelled history — the
// dashboard view of the daemon's schedule table.
function RemindersSection() {
  const schedules = useStore((s) => s.schedules);
  if (schedules.length === 0) return null;
  return (
    <div className="rail-section">
      <div className="rail-heading">Reminders</div>
      {schedules.map((r) => (
        <div key={r.id} className="reminder-row" data-status={r.status}>
          <span className="task-dot" data-status={r.status} />
          <span className="reminder-text">{r.text}</span>
          <span className="reminder-when">{fireLabel(r.fire_at)}</span>
        </div>
      ))}
    </div>
  );
}

// M5: generated-image gallery. Thumbnails stream from /files/images/<name> (the daemon
// serves that subtree); click for a full-size lightbox. Local useState only — no lifecycle.
function GallerySection() {
  const images = useStore((s) => s.images);
  const [open, setOpen] = useState<string | null>(null);
  if (images.length === 0) return null;
  return (
    <div className="rail-section">
      <div className="rail-heading">Images</div>
      <div className="gallery">
        {images.map((img) => (
          <button key={img.file} className="thumb" title={img.file} onClick={() => setOpen(img.file)}>
            <img src={`/files/images/${encodeURIComponent(img.file)}`} alt={img.file} loading="lazy" />
          </button>
        ))}
      </div>
      {open && (
        <div className="lightbox" onClick={() => setOpen(null)}>
          <img src={`/files/images/${encodeURIComponent(open)}`} alt={open} />
        </div>
      )}
    </div>
  );
}

// M7: the computer-use host allowlist. Sites here flow without a notch confirm (browser
// lane + script-lane URL gate); everything else asks per task. base entries are
// config-owned (shown, not removable); remembered ones manage via /api/hosts.
function AllowlistSection() {
  const hosts = useStore((s) => s.hosts);
  const [draft, setDraft] = useState('');
  const add = () => {
    const host = draft.trim().toLowerCase();
    // bare hostname WITH a dot — same rule the API enforces (rejects "com"-style TLD rows)
    if (!host || /[\s/:]/.test(host) || !host.includes('.')) return;
    void mutateHost('POST', host);
    setDraft('');
  };
  return (
    <div className="rail-section">
      <div className="rail-heading">Allowed sites</div>
      {hosts.base.map((h) => (
        <div key={`base-${h}`} className="host-row" title="from config (allowedHosts)">
          <span className="host-name">{h}</span>
          <span className="host-kind">config</span>
        </div>
      ))}
      {hosts.remembered.map((h) => (
        <div key={h} className="host-row">
          <span className="host-name">{h}</span>
          <button className="host-remove" title={`forget ${h}`} onClick={() => void mutateHost('DELETE', h)}>
            ×
          </button>
        </div>
      ))}
      {hosts.base.length === 0 && hosts.remembered.length === 0 && (
        <div className="host-empty">none yet — sites ask via the notch, or add one here</div>
      )}
      <div className="host-add">
        <input
          value={draft}
          placeholder="example.com"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button onClick={add} disabled={!draft.trim()}>
          allow
        </button>
      </div>
    </div>
  );
}

function Rail() {
  return (
    <nav className="rail">
      <TasksSection />
      <RemindersSection />
      <GallerySection />
      <AllowlistSection />
    </nav>
  );
}

const Row = memo(function Row({ event }: { event: EventRow }) {
  const p = event.payload ?? {};
  const time = <span className="stamp">{stamp(event.ts)}</span>;
  const chip = event.task_id ? <span className="task-chip">{event.task_id} · </span> : null;

  switch (event.type) {
    case 'transcript.user':
    case 'transcript.assistant': {
      const who = event.type === 'transcript.user' ? 'you' : 'gumbo';
      return (
        <div className="say" data-who={who}>
          <span className="who">{who}</span>
          <span className="text">{String(p.text ?? '')}</span>
          {time}
        </div>
      );
    }
    case 'tool.call':
      return (
        <div className="machine" data-kind="call">
          <span className="tag">tool</span>
          <span className="body">{chip}▸ {String(p.name ?? '?')} {String(p.args ?? '')}</span>
          {time}
        </div>
      );
    case 'tool.result':
      return (
        <div className="machine" data-kind="result">
          <span className="tag">tool</span>
          <span className="body">{chip}◂ {String(p.output ?? '').slice(0, 300)}</span>
          {time}
        </div>
      );
    case 'subagent.message':
      return (
        <div className="machine" data-kind="subagent">
          <span className="tag">agent</span>
          <span className="body">{chip}{String(p.text ?? '').slice(0, 400)}</span>
          {time}
        </div>
      );
    // M4: Claude Code session stream.
    case 'claude.message':
      return (
        <div className="machine" data-kind="claude">
          <span className="tag">claude</span>
          <span className="body">{chip}{String(p.text ?? '').slice(0, 400)}</span>
          {time}
        </div>
      );
    case 'claude.tool_use':
      return (
        <div className="machine" data-kind="call">
          <span className="tag">claude</span>
          <span className="body">{chip}▸ {String(p.name ?? '?')} {String(p.input ?? '')}</span>
          {time}
        </div>
      );
    case 'claude.tool_result':
      return (
        <div className="machine" data-kind="result">
          <span className="tag">claude</span>
          <span className="body">{chip}◂ {String(p.output ?? '').slice(0, 300)}</span>
          {time}
        </div>
      );
    case 'claude.plan':
      return (
        <div className="machine" data-kind="plan">
          <span className="tag">plan</span>
          <span className="body">{chip}⧉ awaiting approval:{'\n'}{String(p.plan ?? '').slice(0, 1200)}</span>
          {time}
        </div>
      );
    case 'supervisor.decision': {
      const body =
        p.kind === 'reply'
          ? `answered: ${String(p.answer ?? '').slice(0, 300)}`
          : p.kind === 'cap'
            ? 'intervention cap hit — paused for the user'
            : `${p.source === 'the user' ? 'the user' : 'policy'} ${String(p.decision ?? '?')}: ${String(p.action ?? '')}`;
      return (
        <div className="machine" data-kind="supervisor" data-decision={String(p.decision ?? p.kind ?? '')}>
          <span className="tag">supervisor</span>
          <span className="body">{chip}{body}</span>
          {time}
        </div>
      );
    }
    case 'task.status':
      return (
        <div className="machine" data-kind="status" data-status={String(p.status ?? '')}>
          <span className="tag">task</span>
          <span className="body">{chip}{p.status === 'needs_input' ? `paused — needs input (${String(p.reason ?? '')})` : `running again (${String(p.reason ?? '')})`}</span>
          {time}
        </div>
      );
    case 'task.created':
      return (
        <div className="machine" data-kind="created">
          <span className="tag">task</span>
          <span className="body">{chip}started — {String(p.title ?? '')}</span>
          {time}
        </div>
      );
    case 'task.finished':
      return (
        <div className="machine" data-kind="finished" data-status={String(p.status ?? '')}>
          <span className="tag">task</span>
          <span className="body">{chip}{String(p.status ?? 'finished')}{p.error ? ` — ${String(p.error).slice(0, 200)}` : ''}</span>
          {time}
        </div>
      );
    case 'session.error':
      return (
        <div className="machine" data-kind="error">
          <span className="tag">error</span>
          <span className="body">{String(p.message ?? '')}</span>
          {time}
        </div>
      );
    // M5: an image landed — show it inline (the gallery keeps the durable copy).
    case 'image.created':
      return (
        <div className="machine" data-kind="image">
          <span className="tag">image</span>
          <span className="body">
            created — {String(p.prompt ?? '').slice(0, 200)}
            {typeof p.file === 'string' && p.file && (
              <img className="feed-thumb" src={`/files/images/${encodeURIComponent(p.file)}`} alt={p.file} loading="lazy" />
            )}
          </span>
          {time}
        </div>
      );
    // M5.5: a typed/voiced edit request in flight (the result arrives as image.created).
    case 'image.edit_requested':
      return (
        <div className="machine" data-kind="image">
          <span className="tag">image</span>
          <span className="body">
            edit requested{p.selection ? ' (selected area)' : ''} — {String(p.prompt ?? '').slice(0, 200)}
          </span>
          {time}
        </div>
      );
    case 'image.generating':
      return (
        <div className="machine" data-kind="image">
          <span className="tag">image</span>
          <span className="body">generating — {String(p.prompt ?? '').slice(0, 200)}</span>
          {time}
        </div>
      );
    case 'image.generate_failed':
    case 'image.edit_failed':
      return (
        <div className="machine" data-kind="error">
          <span className="tag">image</span>
          <span className="body">
            {event.type === 'image.generate_failed' ? 'generation' : 'edit'} failed — {String(p.error ?? '').slice(0, 200)}
          </span>
          {time}
        </div>
      );
    // M5: scheduler lifecycle rows.
    case 'reminder.set':
    case 'reminder.fired':
    case 'reminder.cancelled': {
      const verb = event.type.split('.')[1];
      return (
        <div className="machine" data-kind="reminder" data-verb={verb}>
          <span className="tag">reminder</span>
          <span className="body">
            {verb} — {String(p.text ?? '')}
            {p.fire_at ? ` (${fireLabel(Number(p.fire_at))})` : ''}
          </span>
          {time}
        </div>
      );
    }
    case 'note.saved':
      return (
        <div className="machine" data-kind="note">
          <span className="tag">note</span>
          <span className="body">saved “{String(p.topic ?? '')}” ({String(p.mode ?? 'append')})</span>
          {time}
        </div>
      );
    case 'session.opened':
    case 'session.closed':
    case 'announce.pending':
      return (
        <div className="machine" data-kind="system">
          <span className="tag">system</span>
          <span className="body">{event.type.replace('.', ' ')}</span>
          {time}
        </div>
      );
    default:
      return null;
  }
});

function ReportPanel({ taskId }: { taskId: string }) {
  const [report, setReport] = useState<string | null>(null);
  if (report !== null) {
    return (
      <div className="report">
        <pre>{report}</pre>
      </div>
    );
  }
  return (
    <button
      className="report-toggle"
      onClick={() => {
        fetch(`/files/tasks/${taskId}/report.md`)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error('no report'))))
          .then(setReport)
          .catch(() => setReport('No report file yet.'));
      }}
    >
      View report
    </button>
  );
}

// Subscribes to streamingText alone, so per-token updates re-render only this line —
// not the whole historical feed.
function StreamingLine() {
  const streamingText = useStore((s) => s.streamingText);
  if (!streamingText) return null;
  return (
    <div className="say" data-who="gumbo">
      <span className="who">gumbo</span>
      <span className="text">
        {streamingText}
        <span className="cursor" />
      </span>
      <span className="stamp" />
    </div>
  );
}

function Feed() {
  const events = useStore((s) => s.events);
  const selected = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);
  const tasks = useStore((s) => s.tasks);
  const feedRef = useRef<HTMLDivElement>(null);

  const visible = selected ? events.filter((e) => e.task_id === selected) : events;
  const selectedTask = tasks.find((t) => t.id === selected);

  return (
    <div className="feed" ref={feedRef}>
      {selected && (
        <div className="feed-filter">
          <span>showing task {selected}{selectedTask ? ` — ${selectedTask.title} (${selectedTask.status})` : ''}</span>
          <button onClick={() => selectTask(null)}>show all activity</button>
        </div>
      )}
      {selected && selectedTask?.status === 'done' && <ReportPanel key={selected} taskId={selected} />}
      {visible.length === 0 && (
        <div className="feed-empty">
          <Simmer />
          <p>The pot is on. Type below to talk to Gumbo — ask it to research something in the background and watch the work land here.</p>
        </div>
      )}
      {visible.map((e) => (
        <Row key={e.seq} event={e} />
      ))}
      {!selected && <StreamingLine />}
      <div
        ref={(el) => {
          const feed = feedRef.current;
          if (!el || !feed) return;
          const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
          if (nearBottom) el.scrollIntoView();
        }}
      />
    </div>
  );
}

function Composer() {
  const connected = useStore((s) => s.connected);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const input = inputRef.current;
    if (!input || !input.value.trim()) return;
    sendDebugText(input.value.trim());
    input.value = '';
  };

  return (
    <div className="composer">
      <input
        ref={inputRef}
        placeholder="Type to Gumbo — voice arrives with the notch app"
        disabled={!connected}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button onClick={submit} disabled={!connected}>Send</button>
    </div>
  );
}

export default function App() {
  return (
    <div className="app">
      <Header />
      <Rail />
      <main className="main">
        <Feed />
        <Composer />
      </main>
    </div>
  );
}
