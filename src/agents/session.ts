import type { EventEmitter } from 'node:events';

/**
 * The contract every agent runtime satisfies, so `AgentManager` can drive any of
 * them the same way. Two implementations exist:
 *   - {@link PtySession}       — a terminal (mock agent, or an onboarded interactive claude)
 *   - {@link StreamJsonSession} — real `claude -p --output-format stream-json`, the
 *     unattended default: no TUI, structured events, bidirectional streaming.
 *
 * Both emit: 'output'(delta), 'waiting'(reason), 'done'(), 'failed'(),
 * 'status'(status), 'exit'(code). The stream runtime additionally emits
 * 'usage'(AgentUsage) at each turn end — cumulative cost/tokens/turns off the
 * `result` event; the PTY runtime has no such channel and never emits it. A
 * legible PTY session (agentMode 'pty') may also emit 'transcript'(text): a
 * full replacement of all prior output after an in-place TUI rewrite.
 */
export type AgentSessionStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'failed';

export interface AgentSession extends EventEmitter {
  readonly status: AgentSessionStatus;
  readonly pid: number | null;
  start(): void;
  /** Deliver text to the agent (initial task, or a human's answer to continue). */
  send(text: string): void;
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
}

/** Builds a session for a given launch spec. Chosen per `agentMode` in the composition root. */
export type SessionFactory = (spec: AgentSessionSpec) => AgentSession;
