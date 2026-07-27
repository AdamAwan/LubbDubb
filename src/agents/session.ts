import type { EventEmitter } from 'node:events';

/**
 * The contract every agent runtime satisfies, so `AgentManager` can drive any of
 * them the same way. Two implementations exist:
 *   - {@link PtySession}       — a terminal (mock agent, or an onboarded interactive claude)
 *   - {@link StreamJsonSession} — real `claude -p --output-format stream-json`, the
 *     unattended default: no TUI, structured events, bidirectional streaming.
 *
 * Both emit: 'output'(delta), 'waiting'(reason), 'done'(), 'failed'(),
 * 'status'(status), 'exit'(code), 'activity'() each time the agent makes a tool
 * call, and 'flag'(ParsedFlag) whenever the agent surfaces an artifact/link via
 * the flag sentinel.
 *
 * `activity` exists because parking is only ever a *request*: the `escalate` tool
 * returns at once, so an agent that keeps working leaves the harness saying
 * `waiting`. It is the runtime's own statement that the agent did something, and
 * it must be emitted only from a source that knows the text is model-produced —
 * which is why it is not simply derived from `output`. A PTY session's raw screen
 * is TUI repainting, not the agent continuing (the same reason the sentinel park
 * is latched in `PtySession`), so PTY emits this only off its session file. It is
 * narrowed to *tool calls* rather than any block: prose after an escalation is
 * usually the agent explaining that it is waiting.
 *
 * The stream runtime
 * additionally emits 'usage'(AgentUsage) at each turn end — cumulative
 * cost/tokens/turns off the `result` event; the PTY runtime has no such channel
 * and never emits it. A legible PTY session (agentMode 'pty') may also emit
 * 'transcript'(text): a full replacement of all prior output after an in-place
 * TUI rewrite.
 */
export type AgentSessionStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'failed';

export interface AgentSession extends EventEmitter {
  readonly status: AgentSessionStatus;
  readonly pid: number | null;
  start(): void;
  /** Deliver text to the agent (initial task, or a human's answer to continue). */
  send(text: string): void;
  /**
   * Deliver the *first* message to a freshly-booted session, robust to any startup
   * race in accepting input. Optional: runtimes whose transport is ready the moment
   * it's spawned (e.g. stream-JSON over stdin) omit it and the caller falls back to
   * {@link send}. The interactive PTY runtime implements it because the claude REPL
   * drops the submitting Enter for a beat while it initialises.
   */
  deliverInitial?(text: string): void;
  /**
   * Write raw bytes to the agent with no added newline/framing (e.g. control chars like \x03).
   * Best-effort: transports without a TTY may no-op.
   */
  sendRaw(data: string): void;
  kill(signal?: string): void;
}

export interface AgentSessionSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  waitingPatterns?: string[];
  /**
   * The id this session runs under, when the runtime pins one. It names the
   * session's transcript file, which the PTY runtime tails instead of scraping the
   * screen — so a resumed session reopens the very file its predecessor wrote.
   */
  sessionId?: string | null;
  /** Resuming an existing session: its transcript already holds the earlier turns. */
  resume?: boolean;
}

/** Builds a session for a given launch spec. Chosen per `agentMode` in the composition root. */
export type SessionFactory = (spec: AgentSessionSpec) => AgentSession;
