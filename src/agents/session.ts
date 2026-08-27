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
 * The stream runtime alone emits 'stalled'(lastWords) — a turn that ended with
 * *no* sentinel in it, carrying the agent's own last words for the reason a park
 * would eventually quote. It is deliberately not 'waiting': a stop is not a
 * question, and an agent that forgot the done sentinel or stopped as if something
 * would wake it when its build finished is answered by asking *it*, not a human.
 * `AgentManager` decides which of the two it becomes. The PTY runtime has no turn
 * boundary to read one off, and parks on silence (`agentIdleWaitMs`) instead.
 *
 * The stream runtime alone also emits 'silent'(ms) — `agentSilenceParkMs` has
 * passed with **no output at all**. It is the one ending not read off a turn
 * boundary, and it exists because an agent wedged *inside* a turn reaches no
 * boundary to be read off: it never ends the turn, so it never stalls, and without
 * a wall clock it holds a slot and a worktree until a person notices. It is not
 * 'stalled': a stop at a turn boundary is an agent that can still be asked
 * something, and this is an agent that has not said a word — which is why
 * `AgentManager` parks it rather than nudging it.
 *
 * The stream runtime
 * additionally emits 'usage'(AgentUsage) at each turn end — cumulative
 * cost/tokens/turns off the `result` event; the PTY runtime has no such channel
 * and never emits it. It alone also emits 'limited'(RateLimitPark) when the
 * account's usage limit is spent: a fourth ending, neither a question nor a
 * failure, which parks the agent until an operator resumes it. The PTY runtime
 * never emits it — the same exhaustion there arrives as screen text, and a park
 * off a scraped sentence is a park an ordinary line of prose can forge.
 *
 * The stream runtime alone emits 'limits'(AccountRateLimits) — the account's 5h /
 * weekly usage windows, read off the *same* `rate_limit_event` the park is. It is
 * a separate event rather than a field on 'limited' because the two are not the
 * same occasion: the windows arrive on every ordinary turn, well inside the
 * limits, and 'limited' is the once that ends a run. A runtime that never emits
 * it leaves the cockpit on its self-computed rolling cost window, which is a
 * degradation and not a fault.
 *
 * A legible PTY session (agentMode 'pty') may also emit 'transcript'(text): a full
 * replacement of all prior output after an in-place TUI rewrite.
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
   * True when the runtime's own transcript already carries the messages *sent to*
   * the agent, so the manager must not write them a second time. The PTY runtime
   * sets it: it renders Claude Code's session file, which records both halves of
   * the conversation (and, degraded to the screen, the TUI echoes what was typed).
   * The stream runtime renders only what comes back, so its sent messages exist
   * nowhere unless the manager echoes them — see `AgentManager.noteSent`.
   */
  readonly recordsSentMessages?: boolean;
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
