import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Agent, Task } from '../types.js';
import { api } from '../api.js';
import { statusDot, linkify } from './util.js';

/**
 * The drill-down: live terminal output for one agent (rendered with xterm.js)
 * plus a box to type a response straight into its session. Seeds from the
 * persisted transcript, then appends live deltas streamed over the socket.
 */
export function AgentDrawer({
  agent,
  task,
  refUrls,
  live,
  onClose,
  onRespond,
  onKill,
  onInterrupt,
}: {
  agent: Agent;
  task: Task | null;
  refUrls: Record<string, string>;
  live: string | undefined;
  onClose: () => void;
  onRespond: (text: string) => Promise<unknown>;
  onKill: () => void;
  onInterrupt: () => void;
}) {
  const [seed, setSeed] = useState('');
  const [text, setText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // The output already written to the terminal — lets us write only the new tail.
  const writtenRef = useRef('');
  const agentIdRef = useRef(agent.id);

  useEffect(() => {
    let active = true;
    api
      .getTranscript(agent.id)
      .then((r) => active && setSeed(r.transcript))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [agent.id]);

  // Mount the terminal once; fit it to the container and keep it fitted on resize.
  useEffect(() => {
    const term = new Terminal({
      convertEol: true, // render \n as a newline (output is not raw PTY)
      scrollback: 100000,
      fontSize: 12.5,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#05070c', foreground: '#b9c6e0' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (containerRef.current) {
      term.open(containerRef.current);
      fit.fit();
    }
    termRef.current = term;
    fitRef.current = fit;
    // Fit again after layout settles (container may be zero-sized on first paint).
    const raf = requestAnimationFrame(() => fitRef.current?.fit());
    const onResize = () => fitRef.current?.fit();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Same output value as before: prefer the live stream once it overtakes the seed.
  const output = live !== undefined && live.length > seed.length ? live : seed;

  // Write-diff into the terminal: append only what's new; on an agent switch or a
  // non-append change (shrink/reseed), reset and rewrite the whole buffer.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const prev = writtenRef.current;
    const switched = agentIdRef.current !== agent.id;
    if (switched || !output.startsWith(prev)) {
      term.reset();
      if (output) term.write(output);
    } else if (output.length > prev.length) {
      term.write(output.slice(prev.length));
    }
    writtenRef.current = output;
    agentIdRef.current = agent.id;
  }, [output, agent.id]);

  const canRespond = agent.status === 'waiting' || agent.status === 'running';
  const isLive = agent.status === 'running' || agent.status === 'waiting' || agent.status === 'starting';

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            {statusDot(agent.status)} <b>{task ? linkify(task.title, refUrls) : agent.id}</b>
            <div className="muted small mono">{agent.cwd}</div>
          </div>
          <div>
            {isLive && (
              <button className="btn" onClick={onInterrupt} title="Send Ctrl-C">
                Interrupt ⌃C
              </button>
            )}
            {agent.status !== 'done' && (
              <button className="btn danger" onClick={onKill}>
                Kill
              </button>
            )}
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="terminal" ref={containerRef} style={{ padding: 8, overflow: 'hidden', minHeight: 240 }} />
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
            <button className="btn primary" type="submit">
              Send
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
