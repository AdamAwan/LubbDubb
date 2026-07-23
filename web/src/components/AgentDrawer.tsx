import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Agent, AgentFlag, Task } from '../types.js';
import { api } from '../api.js';
import { statusDot, linkify, agentUsageLine } from './util.js';
import { ConfirmButton } from './ConfirmButton.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { FlagChips } from './FlagChips.js';

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
  flags,
  onClose,
  onRespond,
  onKill,
  onInterrupt,
}: {
  agent: Agent;
  task: Task | null;
  refUrls: Record<string, string>;
  live: string | undefined;
  flags?: AgentFlag[];
  onClose: () => void;
  onRespond: (text: string) => Promise<unknown>;
  onKill: () => Promise<unknown> | unknown;
  onInterrupt: () => Promise<unknown> | unknown;
}) {
  const [seed, setSeed] = useState('');
  const [text, setText] = useState('');
  const send = useAsyncAction();
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
      convertEol: true, // output is legible text in every mode (renderBlocks / settled PTY text), never raw TUI bytes
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
            {agentUsageLine(agent) && (
              <div className="muted small mono" title="Claude cost · input→output tokens · turns (cumulative)">
                {agentUsageLine(agent)}
              </div>
            )}
          </div>
          <div>
            {isLive && (
              <AsyncButton
                onClick={onInterrupt}
                title="Send Ctrl-C"
                pendingLabel={<span className="spinner" aria-hidden />}
              >
                Interrupt ⌃C
              </AsyncButton>
            )}
            {agent.status !== 'done' && (
              <ConfirmButton label="Kill" confirmLabel="Confirm kill" pendingLabel="Killing…" onConfirm={onKill} />
            )}
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {task && (task.originTitle || task.originSummary || task.dispatchReason) && (
          <div className="origin-context">
            {task.originTitle && (
              <div className="origin-title">
                {task.originRef && <span className="chip small">{task.originRef}</span>}
                <span>{task.originTitle}</span>
              </div>
            )}
            {task.originSummary && <div className="origin-summary">{task.originSummary}</div>}
            {task.dispatchReason && (
              <div className="dispatch-reason">
                <span className="dispatch-reason-label">Dispatched because</span> {task.dispatchReason}
              </div>
            )}
          </div>
        )}
        {flags && flags.length > 0 && (
          <div className="drawer-flags">
            <span className="drawer-flags-label">Artifacts</span>
            <FlagChips flags={flags} />
          </div>
        )}
        <div className="terminal" ref={containerRef} style={{ padding: 8, overflow: 'hidden', minHeight: 240 }} />
        {canRespond && (
          <form
            className="reply"
            onSubmit={(e) => {
              e.preventDefault();
              const value = text.trim();
              if (!value) return;
              void send.run(async () => {
                await onRespond(value);
                setText('');
              });
            }}
          >
            <input placeholder="Type into this agent…" value={text} onChange={(e) => setText(e.target.value)} />
            <SubmitButton phase={send.phase} className="primary">
              Send
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}
