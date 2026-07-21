import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentSession, AgentSessionSpec, AgentSessionStatus } from './session.js';

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

const defaultSpawner: Spawner = (command, args, opts) =>
  nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as StreamChild;

const DONE_SENTINEL = '@@LUBBDUBB_DONE@@';
const WAIT_PREFIX = '@@LUBBDUBB_WAITING:';
const WAIT_SUFFIX = '@@';

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
      const text = extractText(ev);
      if (text) {
        this.turnText += text;
        this.emit('output', text);
      }
      return;
    }

    if (ev.type === 'result') {
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
  message?: { content?: Array<{ type: string; text?: string }> | string };
}

function extractText(ev: StreamEvent): string {
  const content = ev.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text as string)
      .join('');
  return '';
}

function extractWaitingReason(text: string): string | null {
  const start = text.indexOf(WAIT_PREFIX);
  if (start === -1) return null;
  const from = start + WAIT_PREFIX.length;
  const end = text.indexOf(WAIT_SUFFIX, from);
  if (end === -1) return null;
  return text.slice(from, end).trim();
}
