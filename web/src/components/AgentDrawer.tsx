import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, AgentFile, AgentFlag, Task } from '../types.js';
import { api } from '../api.js';
import { statusDot, linkify, agentUsageLine } from './util.js';
import { Ref } from './refs.js';
import { ConfirmButton } from './ConfirmButton.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { FlagChips } from './FlagChips.js';
import { FilesList } from './FilesList.js';
import { parseAnsi, ansiClass, type AnsiStyle } from './ansi.js';
import { feedBlocks, emptyBlockState, type BlockState } from './transcriptBlocks.js';

/** How close to the bottom (px) still counts as "following the stream". */
const STICK_THRESHOLD = 24;

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
}

/** What one pane carries between deltas: ANSI run, block parse, and the open block's body. */
interface PaneState {
  ansi: AnsiStyle;
  blocks: BlockState;
  /** The open block's body, or null when writing straight into the pane. */
  body: HTMLElement | null;
}

/** Append styled text into `target`, resuming the ANSI run and returning where it ends. */
function appendStyled(target: HTMLElement, text: string, style: AnsiStyle): AnsiStyle {
  const { segments, end } = parseAnsi(text, style);
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
  target.appendChild(frag);
  return end;
}

/** A collapsed tool call: its summary line, and an empty body for the result. */
function openBlock(summary: string, error: boolean): { block: HTMLDetailsElement; body: HTMLElement } {
  const block = document.createElement('details');
  block.className = error ? 'tool-block error' : 'tool-block';
  // A failure that hides is worse than a noisy one, so an error is never collapsed.
  block.open = error;
  const head = document.createElement('summary');
  appendStyled(head, summary, {});
  block.appendChild(head);
  const body = document.createElement('div');
  body.className = 'tool-body';
  block.appendChild(body);
  return { block, body };
}

/**
 * Apply a transcript chunk to the pane as blocks. `tailEl` holds the line still being
 * written — it is rewritten each delta and everything else is inserted before it, so
 * streaming text shows immediately without the parser having to guess at a partial line.
 */
function appendChunk(el: HTMLElement, tailEl: HTMLElement, chunk: string, state: PaneState): void {
  const { ops, tail, state: blocks } = feedBlocks(chunk, state.blocks);
  for (const op of ops) {
    if (op.kind === 'open') {
      const { block, body } = openBlock(op.text ?? '', op.error === true);
      el.insertBefore(block, tailEl);
      state.body = body;
      state.ansi = {};
    } else if (op.kind === 'close') {
      state.body = null;
      state.ansi = {};
    } else {
      const target = state.body ?? proseSlot(el, tailEl);
      state.ansi = appendStyled(target, op.text ?? '', state.ansi);
    }
  }
  tailEl.replaceChildren();
  if (tail) appendStyled(tailEl, tail, state.ansi);
  state.blocks = blocks;
}

/** Prose accumulates in one span before the tail, so appends stay ordered. */
function proseSlot(el: HTMLElement, tailEl: HTMLElement): HTMLElement {
  const prev = tailEl.previousElementSibling;
  if (prev instanceof HTMLElement && prev.classList.contains('prose')) return prev;
  const span = document.createElement('span');
  span.className = 'prose';
  el.insertBefore(span, tailEl);
  return span;
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
  limitParked,
  onClose,
  onRespond,
  onKill,
  onComplete,
  onInterrupt,
  onResume,
}: {
  agent: Agent;
  task: Task | null;
  refUrls: Record<string, string>;
  live: string | undefined;
  flags?: AgentFlag[];
  artifactUrls: Record<string, string>;
  files?: AgentFile[];
  /** Parked because the account's usage limit is spent, not because it asked anything. */
  limitParked: boolean;
  onClose: () => void;
  onRespond: (text: string) => Promise<unknown>;
  onKill: () => Promise<unknown> | unknown;
  /** Declare the work finished: the clean terminal an agent reaches with a done sentinel. */
  onComplete: () => Promise<unknown> | unknown;
  onInterrupt: () => Promise<unknown> | unknown;
  /** End a usage-limit park: re-open the conversation and carry on. */
  onResume: () => Promise<unknown> | unknown;
}) {
  const [seed, setSeed] = useState('');
  const [text, setText] = useState('');
  // The stream ran ahead while the user was scrolled up — offer a jump-to-latest.
  const [behind, setBehind] = useState(false);
  const send = useAsyncAction();
  const paneRef = useRef<HTMLDivElement>(null);
  // What's already rendered into the pane, so we append only the new tail.
  const writtenRef = useRef('');
  // Parse and style state carried across appends (a run can split across deltas).
  const stateRef = useRef<PaneState>({ ansi: {}, blocks: emptyBlockState, body: null });
  // The line still being written, kept as the pane's last child.
  const tailRef = useRef<HTMLSpanElement | null>(null);
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
    // No tail element yet means nothing has been written — the first frame renders an
    // empty transcript, and the seed that follows it is a rewrite, not an append.
    if (switched || !output.startsWith(prev) || !tailRef.current) {
      el.replaceChildren();
      stateRef.current = { ansi: {}, blocks: emptyBlockState, body: null };
      // Expansion is DOM-only state, so a reseed starts every block collapsed.
      const tailEl = document.createElement('span');
      el.appendChild(tailEl);
      tailRef.current = tailEl;
      appendChunk(el, tailEl, output, stateRef.current);
      el.scrollTop = el.scrollHeight;
      setBehind(false);
    } else if (output.length > prev.length && tailRef.current) {
      appendChunk(el, tailRef.current, output.slice(prev.length), stateRef.current);
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

  // A limit park takes the reply box away rather than leaving one that cannot send:
  // the process is usually gone with the limit, so typing here would reach nothing —
  // and there is no question on the other end of it to answer.
  const canRespond = !limitParked && (agent.status === 'waiting' || agent.status === 'running');
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
            {isLive && (
              <ConfirmButton
                label="Mark done"
                confirmLabel="Confirm done"
                pendingLabel="Finishing…"
                onConfirm={onComplete}
              />
            )}
            {agent.status !== 'done' && (
              <ConfirmButton label="Kill" confirmLabel="Confirm kill" pendingLabel="Killing…" onConfirm={onKill} />
            )}
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {task && (task.originTitle || task.originSummary || task.dispatchReason || task.model) && (
          <div className="origin-context">
            {task.originTitle && (
              <div className="origin-title">
                {/* The way back to what this agent was sent at — a goal's page,
                    or the pull request when no ticket owns the work. */}
                {task.originRef && (
                  <span className="chip small">
                    <Ref to={task.originRef} />
                  </span>
                )}
                <span>{task.originTitle}</span>
              </div>
            )}
            {task.originSummary && <div className="origin-summary">{task.originSummary}</div>}
            {task.dispatchReason && (
              <div className="dispatch-reason">
                <span className="dispatch-reason-label">Dispatched because</span> {task.dispatchReason}
              </div>
            )}
            {/* What this run was launched on — the `agentModels` profile its rule
                resolved to at dispatch, so reading a run says what it cost on.
                Model and effort are one profile's two halves and read as one line;
                an effort with no model is not a state the resolver can produce. */}
            {task.model && (
              <div className="dispatch-model">
                <span className="dispatch-reason-label">Model</span> {task.model}
                {task.effort && ` · ${task.effort} effort`}
                {/* Which profile, and which level of the chain named it (#342). A
                    pinned run cost what somebody chose for this goal rather than
                    what its rule prices — and a bumped agent that reads as an
                    ordinary one is the invisible half of pinning. Drawn from the
                    stored source, never recomputed against today's config: the
                    policy moves, and a finished run must keep saying what it was
                    dispatched under. */}
                {task.profile && (
                  <span
                    className={`chip small${task.profileSource === 'pin' ? ' warn' : ''}`}
                    title={
                      task.profileSource === 'pin'
                        ? 'Pinned — this goal, or its plan, named this profile rather than taking its rule’s'
                        : task.profileSource === 'rule'
                          ? 'This dispatch rule’s own profile'
                          : 'The fleet default, for a rule with no profile of its own'
                    }
                  >
                    {task.profile}
                    {task.profileSource === 'pin' ? ' · pinned' : ''}
                  </span>
                )}
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
        {limitParked && (
          <div className="park-notice">
            <b>Parked on a usage limit.</b>{' '}
            {agent.waitingReason ?? 'This account has no usage allowance left right now.'}
            <AsyncButton className="primary" onClick={onResume} pendingLabel="Resuming…">
              Resume
            </AsyncButton>
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
