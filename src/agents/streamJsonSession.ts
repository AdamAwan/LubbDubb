import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentSession, AgentSessionSpec, AgentSessionStatus } from './session.js';
import { DONE_SENTINEL, extractFlags, extractWaitingReason, stripSentinels } from './sentinels.js';
import { resolveExecutable } from './resolveCommand.js';
import type { ProcessReaper } from './processTree.js';
import { assistantText, renderBlocks, type ContentBlock } from './streamTranscript.js';
import type { AccountRateLimits, AgentUsage, RateLimitWindow } from '../types.js';
import { debugLog } from '../debug.js';

// → docs/spec/10-agent-runtimes.md

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
  const resolved = resolveExecutable(command, opts.env);
  return nodeSpawn(resolved, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }) as unknown as StreamChild;
};

function parseEventLine(line: string): StreamEvent | null {
  for (let i = line.indexOf('{'); i !== -1; i = line.indexOf('{', i + 1)) {
    try {
      return JSON.parse(line.slice(i)) as StreamEvent;
    } catch {
      // This `{` opened something that is not the event; try the next one.
    }
  }
  return null;
}

export class StreamJsonSession extends EventEmitter implements AgentSession {
  private child: StreamChild | null = null;
  private _status: AgentSessionStatus = 'starting';
  private stdoutBuf = '';
  private turnText = '';
  private pendingTurns = 0;
  private limit: RateLimitPark | null = null;
  private limitParked = false;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly spawn: Spawner = defaultSpawner,
    private readonly reap: ProcessReaper = () => {},
    private readonly silenceMs: number = 0,
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

  send(text: string): void {
    if (!this.child) throw new Error('StreamJsonSession not started');
    const msg = { type: 'user', message: { role: 'user', content: text } };
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    this.pendingTurns += 1;
    if (this._status === 'waiting') this.setStatus('running');
    this.armSilence();
  }

  sendRaw(_data: string): void {
    /* intentionally empty — no raw byte channel on the JSON transport */
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.clearSilence();
    if (this.child && ['starting', 'running', 'waiting'].includes(this._status)) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      const pid = this.child.pid;
      if (pid !== undefined) this.reap(pid);
      this.child.kill(signal);
      this.setStatus('killed');
    }
  }

  private onStdout(chunk: string): void {
    this.armSilence();
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim()) this.handleEvent(line);
    }
  }

  private handleEvent(line: string): void {
    const ev = parseEventLine(line);
    if (!ev) {
      debugLog('agent', `unparseable stream line (${line.length} bytes)`);
      return;
    }

    if (ev.type === 'assistant') {
      const blocks = contentBlocks(ev);
      const raw = assistantText(blocks);
      this.turnText += raw;
      for (const flag of extractFlags(raw)) this.emit('flag', flag);
      if (blocks.some((b) => b.type === 'tool_use')) this.emit('activity');
      const display = renderBlocks(blocks, new Date().toISOString());
      if (display) this.emit('output', display);
      return;
    }

    if (ev.type === 'user') {
      const results = contentBlocks(ev).filter((b) => b.type === 'tool_result');
      const display = renderBlocks(results, new Date().toISOString());
      if (display) this.emit('output', display);
      return;
    }

    if (ev.type === 'rate_limit_event') {
      const reading = rateLimitReading(ev.rate_limit_info, new Date().toISOString());
      if (reading) this.emit('limits', reading);
      this.limit = rateLimitPark(ev.rate_limit_info);
      return;
    }

    if (ev.type === 'result') {
      const usage = resultUsage(ev);
      if (usage) this.emit('usage', usage);
      const turnText = this.turnText;
      this.turnText = '';
      if (this.pendingTurns > 0) this.pendingTurns -= 1;
      if (turnText.includes(DONE_SENTINEL)) {
        this.finish('done');
        return;
      }
      if (this.pendingTurns > 0) return;
      if (this.limit) {
        this.parkOnLimit();
      } else {
        const reason = extractWaitingReason(turnText);
        if (reason !== null) this.setWaiting(reason);
        else this.stall(turnText);
      }
    }
  }

  private stall(turnText: string): void {
    if (this._status === 'waiting' || this._status === 'done') return;
    this.setStatus('waiting');
    this.emit('stalled', stripSentinels(turnText).trim());
  }

  private setWaiting(reason: string): void {
    if (this._status === 'waiting' || this._status === 'done') return;
    this.setStatus('waiting');
    this.emit('waiting', reason);
  }

  private parkOnLimit(): void {
    if (this.limitParked || this._status === 'done' || this._status === 'killed') return;
    this.limitParked = true;
    this.setStatus('waiting');
    this.emit('limited', this.limit);
  }

  private onExit(code: number | null): void {
    this.emit('exit', code ?? 0);
    if (this._status === 'killed' || this._status === 'done') return;
    if (this.limit) {
      this.parkOnLimit();
      return;
    }
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
    this.armSilence();
  }

  private armSilence(): void {
    this.clearSilence();
    if (this.silenceMs <= 0 || this._status !== 'running') return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.emit('silent', this.silenceMs);
    }, this.silenceMs);
    this.silenceTimer.unref?.();
  }

  private clearSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }
}

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
  unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown } | undefined>;
}

export interface RateLimitPark {
  limitType: string | null;
  resetsAt: string | null;
  overage: boolean;
}

function rateLimitPark(info: RateLimitInfo | undefined): RateLimitPark | null {
  if (!info) return null;
  const overage = info.isUsingOverage === true && info.overageStatus === 'rejected';
  if (info.status !== 'rejected' && !overage) return null;
  return {
    limitType: info.rateLimitType ?? null,
    resetsAt: typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : null,
    overage,
  };
}

function rateLimitReading(info: RateLimitInfo | undefined, capturedAt: string): AccountRateLimits | null {
  const windows = info?.unifiedWindows;
  if (!windows || typeof windows !== 'object') return null;
  const fiveHour = readWindow(windows.five_hour);
  const sevenDay = readWindow(windows.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, capturedAt };
}

function readWindow(w: { utilization?: unknown; resetsAt?: unknown } | undefined): RateLimitWindow | null {
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  return {
    usedPercentage: w.utilization * 100,
    resetsAt:
      typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : null,
  };
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { content?: ContentBlock[] | string };
  rate_limit_info?: RateLimitInfo;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function resultUsage(ev: StreamEvent): AgentUsage | null {
  const u = ev.usage;
  if (ev.total_cost_usd === undefined && ev.num_turns === undefined && u === undefined) return null;
  return {
    costUsd: ev.total_cost_usd ?? null,
    inputTokens: u
      ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      : null,
    outputTokens: u?.output_tokens ?? null,
    cacheReadTokens: u ? (u.cache_read_input_tokens ?? 0) : null,
    cacheCreationTokens: u ? (u.cache_creation_input_tokens ?? 0) : null,
    numTurns: ev.num_turns ?? null,
  };
}

function contentBlocks(ev: StreamEvent): ContentBlock[] {
  const content = ev.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}
