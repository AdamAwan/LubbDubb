import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, AgentFile, AgentFlag, Task } from '../types.js';
import { api } from '../api.js';
import { statusDot, linkify, agentUsageLine } from './util.js';
import { ConfirmButton } from './ConfirmButton.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { FlagChips } from './FlagChips.js';
import { FilesList } from './FilesList.js';
import { parseAnsi, ansiClass, type AnsiStyle } from './ansi.js';

/** How close to the bottom (px) still counts as "following the stream". */
const STICK_THRESHOLD = 24;

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
}

/** Append a transcript chunk as styled DOM, resuming ANSI state across deltas. */
function appendChunk(el: HTMLElement, chunk: string, styleRef: { current: AnsiStyle }): void {
  const { segments, end } = parseAnsi(chunk, styleRef.current);
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    const cls = ansiClass(seg.style);
    if (!cls) {
      frag.appendChild(document.createTextNode(seg.text));
    } else {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = seg.text;
      frag.appendChild(span);
    }
  }
  el.appendChild(frag);
  styleRef.current = end;
}

/**
 * The drill-down: the transcript for one agent, rendered as an HTML pane, plus a
 * box to type a response straight into its session. Seeds from the persisted
 * transcript, then appends live deltas streamed over the socket.
 *
 * The transcript is already legible text in every mode (`renderBlocks` / settled
 * PTY text), never raw TUI bytes, so it renders as real DOM: words wrap on their
 * boundaries, the browser scrolls it natively, and the text is selectable. The
 * only terminal feature we reproduce is SGR colour on tool labels (see `ansi.ts`).
 */
export function AgentDrawer({
  agent,
  task,
  refUrls,
  live,
  flags,
  artifactUrls,
  files,
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
  artifactUrls: Record<string, string>;
  files?: AgentFile[];
  onClose: () => void;
  onRespond: (text: string) => Promise<unknown>;
  onKill: () => Promise<unknown> | unknown;
  onInterrupt: () => Promise<unknown> | unknown;
}) {
  const [seed, setSeed] = useState('');
  const [text, setText] = useState('');
  // The stream ran ahead while the user was scrolled up — offer a jump-to-latest.
  const [behind, setBehind] = useState(false);
  const send = useAsyncAction();
  const paneRef = useRef<HTMLDivElement>(null);
  // What's already rendered into the pane, so we append only the new tail.
  const writtenRef = useRef('');
  // ANSI style carried across appends (a colour run can split across deltas).
  const ansiRef = useRef<AnsiStyle>({});
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

  // Same output value as before: prefer the live stream once it overtakes the seed.
  const output = live !== undefined && live.length > seed.length ? live : seed;

  // Render-diff into the pane: append only what's new; on an agent switch or a
  // non-append change (shrink/reseed), clear and rewrite the whole buffer.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const prev = writtenRef.current;
    const switched = agentIdRef.current !== agent.id;
    const following = atBottom(el);
    if (switched || !output.startsWith(prev)) {
      el.replaceChildren();
      ansiRef.current = {};
      appendChunk(el, output, ansiRef);
      el.scrollTop = el.scrollHeight;
      setBehind(false);
    } else if (output.length > prev.length) {
      appendChunk(el, output.slice(prev.length), ansiRef);
      if (following) {
        el.scrollTop = el.scrollHeight;
        setBehind(false);
      } else {
        setBehind(true);
      }
    }
    writtenRef.current = output;
    agentIdRef.current = agent.id;
  }, [output, agent.id]);

  const onScroll = useCallback(() => {
    const el = paneRef.current;
    if (el && atBottom(el)) setBehind(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = paneRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setBehind(false);
  }, []);

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
            <FlagChips flags={flags} artifactUrls={artifactUrls} />
          </div>
        )}
        <FilesList files={files} />
        <div className="terminal-wrap">
          <div className="terminal" ref={paneRef} onScroll={onScroll} aria-label="Agent transcript" />
          {behind && (
            <button type="button" className="term-jump" onClick={jumpToLatest}>
              ↓ New output
            </button>
          )}
        </div>
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
