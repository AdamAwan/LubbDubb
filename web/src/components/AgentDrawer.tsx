import { useEffect, useRef, useState } from 'react';
import type { Agent, Task } from '../types.js';
import { api } from '../api.js';
import { statusDot } from './util.js';

/**
 * The drill-down: live terminal output for one agent plus a box to type a
 * response straight into its session. Seeds from the persisted transcript, then
 * appends live deltas streamed over the socket.
 */
export function AgentDrawer({
  agent,
  task,
  live,
  onClose,
  onRespond,
  onKill,
}: {
  agent: Agent;
  task: Task | null;
  live: string | undefined;
  onClose: () => void;
  onRespond: (text: string) => Promise<unknown>;
  onKill: () => void;
}) {
  const [seed, setSeed] = useState('');
  const [text, setText] = useState('');
  const bodyRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let active = true;
    api.getTranscript(agent.id).then((r) => active && setSeed(r.transcript)).catch(() => {});
    return () => {
      active = false;
    };
  }, [agent.id]);

  const output = live !== undefined && live.length > seed.length ? live : seed;
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [output]);

  const canRespond = agent.status === 'waiting' || agent.status === 'running';

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            {statusDot(agent.status)} <b>{task?.title ?? agent.id}</b>
            <div className="muted small mono">{agent.cwd}</div>
          </div>
          <div>
            {agent.status !== 'done' && <button className="btn danger" onClick={onKill}>Kill</button>}
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
        <pre className="terminal" ref={bodyRef}>{output || '(no output yet)'}</pre>
        {canRespond && (
          <form
            className="reply"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) {
                void onRespond(text.trim());
                setText('');
              }
            }}
          >
            <input placeholder="Type into this agent…" value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn primary" type="submit">Send</button>
          </form>
        )}
      </div>
    </div>
  );
}
