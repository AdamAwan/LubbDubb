import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentSession, AgentSessionSpec, AgentSessionStatus } from './session.js';
import { DONE_SENTINEL, extractWaitingReason } from './sentinels.js';
import { resolveExecutable } from './resolveCommand.js';
import { assistantText, renderBlocks, type ContentBlock } from './streamTranscript.js';
import type { AgentUsage } from '../types.js';

/**
 * Minimal child-process shape we depend on — injectable so tests drive a fake
 * process without launching claude.
 */
export interface StreamChild {
  readonly pid: number | undefined;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream;
  on(event: 'exit', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals | number): void;
}

export type Spawner = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => StreamChild;

const defaultSpawner: Spawner = (command, args, opts) => {
  // Resolve the command the same way the PTY backend does, so a missing `claude`
  // fails synchronously with a clear message instead of an unhandled async ENOENT.
  const resolved = resolveExecutable(command, opts.env);
  return nodeSpawn(resolved, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as StreamChild;
};

/**
 * Drives a real `claude` agent over the streaming-JSON protocol
 * (`-p --input-format stream-json --output-format stream-json`). This is the
 * production agent runtime: it never renders the interactive TUI, works
 * unattended, and supports the harness's waiting/answer loop because the session
 * stays alive across turns as long as stdin is open.
 *
 * Turn semantics: each user message drives one assistant turn ending in a
 * `result` event. We scan assistant text for the harness sentinels:
 *   - DONE seen                 -> the agent finished the whole task
 *   - WAITING seen              -> it needs a human; escalate, then send the answer
 *   - turn ended with neither   -> treated as waiting (it stopped without finishing)
 */
export class StreamJsonSession extends EventEmitter implements AgentSession {
  private child: StreamChild | null = null;
  private _status: AgentSessionStatus = 'starting';
  private stdoutBuf = '';
  /** Assistant text accumulated within the current turn, for sentinel scanning. */
  private turnText = '';

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly spawn: Spawner = defaultSpawner,
  ) {
    super();
  }

  get status(): AgentSessionStatus {
    return this._status;
  }
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.child) throw new Error('StreamJsonSession already started');
    this.child = this.spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
    });
    this.setStatus('running');
    this.child.stdout.on('data', (d: Buffer | string) => this.onStdout(d.toString()));
    this.child.on('exit', (code) => this.onExit(code));
  }

  /** Send a user message (initial task or a human answer) as one JSON line. */
  send(text: string): void {
    if (!this.child) throw new Error('StreamJsonSession not started');
    const msg = { type: 'user', message: { role: 'user', content: text } };
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    this.turnText = '';
    if (this._status === 'waiting') this.setStatus('running');
  }

  /**
   * No-op: the stream-JSON protocol carries structured user messages, not a raw
   * TTY, so control chars like \x03 aren't meaningful over this transport. Kept
   * to satisfy the {@link AgentSession} contract.
   */
  sendRaw(_data: string): void {
    /* intentionally empty — no raw byte channel on the JSON transport */
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child && ['starting', 'running', 'waiting'].includes(this._status)) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      this.child.kill(signal);
      this.setStatus('killed');
    }
  }

  // -- internals -----------------------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim()) this.handleEvent(line);
    }
  }

  private handleEvent(line: string): void {
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      return; // non-JSON noise
    }

    if (ev.type === 'assistant') {
      const blocks = contentBlocks(ev);
      // Detection scans the raw assistant text (sentinels intact); display strips them.
      this.turnText += assistantText(blocks);
      const display = renderBlocks(blocks);
      if (display) this.emit('output', display);
      return;
    }

    if (ev.type === 'user') {
      // Incoming user events on stdout are tool results the CLI produced. Render
      // only those blocks — plain-text user content is our own echoed input.
      const results = contentBlocks(ev).filter((b) => b.type === 'tool_result');
      const display = renderBlocks(results);
      if (display) this.emit('output', display);
      return;
    }

    if (ev.type === 'result') {
      // Surface the usage metadata riding on the turn-end event (cumulative
      // cost/tokens/turns) before the status transition, so listeners persist
      // it ahead of the waiting/done fan-out.
      const usage = resultUsage(ev);
      if (usage) this.emit('usage', usage);
      // End of a turn: decide done vs waiting from the sentinels the agent printed.
      if (this.turnText.includes(DONE_SENTINEL)) {
        this.finish('done');
      } else {
        const reason =
          extractWaitingReason(this.turnText) ?? 'Agent ended its turn without finishing; awaiting direction.';
        this.setWaiting(reason);
      }
      this.turnText = '';
    }
  }

  private setWaiting(reason: string): void {
    if (this._status === 'waiting' || this._status === 'done') return;
    this.setStatus('waiting');
    this.emit('waiting', reason);
  }

  private onExit(code: number | null): void {
    this.emit('exit', code ?? 0);
    if (this._status === 'killed' || this._status === 'done') return;
    this.finish(code === 0 ? 'done' : 'failed');
  }

  private finish(status: 'done' | 'failed'): void {
    if (this._status === 'done' || this._status === 'failed') return;
    this.setStatus(status);
    this.emit(status);
    try {
      this.child?.stdin.end();
    } catch {
      /* ignore */
    }
  }

  private setStatus(status: AgentSessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { content?: ContentBlock[] | string };
  // `result`-event usage metadata, all cumulative across the session.
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Pull the cumulative usage off a `result` event, or null when it carries none. */
function resultUsage(ev: StreamEvent): AgentUsage | null {
  const u = ev.usage;
  if (ev.total_cost_usd === undefined && ev.num_turns === undefined && u === undefined) return null;
  return {
    costUsd: ev.total_cost_usd ?? null,
    // Cache tokens count as input: with caching on, bare input_tokens is a tiny
    // residue and would wildly under-report what the turn actually consumed.
    inputTokens: u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null,
    outputTokens: u?.output_tokens ?? null,
    numTurns: ev.num_turns ?? null,
  };
}

/** Normalise a message's `content` into a block array (a bare string becomes one text block). */
function contentBlocks(ev: StreamEvent): ContentBlock[] {
  const content = ev.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}
