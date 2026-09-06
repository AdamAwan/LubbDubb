import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { STREAM_TRANSPORT_ARGS } from '../agents/agentProtocol.js';
import type { AgentSession, SessionFactory } from '../agents/session.js';
import type { ProcessReaper } from '../agents/processTree.js';
import { HUMAN_BLOCK, renderBlocks } from '../agents/streamTranscript.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import type { AgentUsage, LocalRun, LocalRunTurn } from '../types.js';
import type { LocalRunChoices } from './ref.js';
import type { LocalRunPolicy } from './policy.js';

// → docs/spec/23-local-runs.md

const TAIL_LINES = 200;

const RUN_RULES = [
  'How this works, on top of the above:',
  '',
  '- Start it in the **background** and leave it running. This session stays open to hold it: the',
  '  server is a child of this process, so if you run it in the foreground you block your own turn,',
  '  and if you stop it before you finish there is nothing left running.',
  '- **Do not stop it, and do not tidy up.** Finishing your turn is not the end of the run — somebody',
  '  is about to look at what you started. It is stopped from the cockpit, which kills this session.',
  '- **Do not commit, push, or change code.** This checkout is detached at a commit somebody else',
  '  wrote and is here to be looked at, not worked on. If it will not start, say why and stop.',
  '- **Say where it landed** — the URL and the port — and say what you had to do that the instruction',
  '  above did not mention. That last part is how the instruction gets better.',
  '- **Before each step, print one line saying what you are about to do, starting with `phase:`** — for',
  '  example `phase: starting the containers`. Somebody is watching this come up and that line is all',
  '  they have to go on until it does. A few words, on a line of its own.',
].join('\n');

const RESUME_RULES = [
  'How this works, on top of the above:',
  '',
  '- **You did not start this, and the session that did is gone.** The harness restarted underneath it.',
  '  Whatever survived that — containers, listening ports, background processes — is this run’s own work,',
  '  not a collision: attach to it, restart only the pieces that did not survive, and do not bring up a',
  '  second copy of anything already up.',
  '- Start whatever you do have to start in the **background** and leave it running. This session stays',
  '  open to hold it: the server is a child of this process, so if you run it in the foreground you block',
  '  your own turn, and if you stop it before you finish there is nothing left running.',
  '- **Do not stop it, and do not tidy up.** Finishing your turn is not the end of the run — somebody',
  '  is about to look at what you brought back. It is stopped from the cockpit, which kills this session.',
  '- **Do not commit, push, or change code.** This checkout is detached at a commit somebody else',
  '  wrote and is here to be looked at, not worked on. If it will not come back, say why and stop.',
  '- **Say where it landed** — the URL and the port — and say what you found already running and what you',
  '  had to start again. That second half is how the instruction gets better.',
  '- **Before each step, print one line saying what you are about to do, starting with `phase:`** — for',
  '  example `phase: checking what is still up`. Somebody is watching this come back and that line is all',
  '  they have to go on until it does. A few words, on a line of its own.',
].join('\n');

const STOP_TIMEOUT_MS = 120_000;

const TURN_ENDED = ['done', 'waiting', 'stalled', 'limited'] as const;

const STOP_RULES = [
  'How this works, on top of the above:',
  '',
  '- **Stop everything that start brought up**, including anything you started that the instruction',
  '  above did not mention. Containers, background processes, ports — the machine should be as it was.',
  '- **Do not commit, push, or change code.** This checkout is somebody else’s commit, and it is about',
  '  to be pointed at another one.',
  '- **Say what you stopped, and what you could not.** The second half is the useful half: anything',
  '  still holding a port is what the next start will collide with.',
  '- **Before each step, print one line starting with `phase:`** — somebody is watching this come down,',
  '  and that line is all they have to go on until it has.',
].join('\n');

const STOP_RULES_ALONE = [
  'How this works, on top of the above:',
  '',
  '- **You did not start this, and the session that did is gone.** Whatever it left running is still',
  '  running: look for it — containers, listening ports, background processes — and stop it.',
  '- **Do not commit, push, or change code.** This checkout is somebody else’s commit, and it is about',
  '  to be pointed at another one.',
  '- **Say what you stopped, and what you could not.** The second half is the useful half: anything',
  '  still holding a port is what the next start will collide with.',
  '- **Before each step, print one line starting with `phase:`** — somebody is watching this come down,',
  '  and that line is all they have to go on until it has.',
].join('\n');

function refreshRules(ref: string, from: string | null, to: string, alone: boolean): string {
  return [
    alone ? 'The code under this environment has changed:' : 'How this works, on top of the above:',
    '',
    `- **The checkout under you has moved.** It now stands at ${to.slice(0, 12)} on \`${ref}\`` +
      (from === null ? '.' : `, having stood at ${from.slice(0, 12)}.`) +
      ' The files on disk already reflect the new commit; nothing has been restarted or rebuilt.',
    '- **Restart or rebuild whatever needs it** so what is running reflects the new code. A dev server that',
    '  hot-reloads may need nothing; a container image or a database schema may need a step. Leave alone',
    '  what does not need touching.',
    '- **Do not stop the environment.** Somebody is looking at it — keep it up throughout.',
    '- **Do not commit, push, or change code.** This checkout is detached at a commit somebody else wrote.',
    '- **Say what you did and what you did not need to touch.** The second half is how the refresh',
    '  instruction gets better.',
    '- **Before each step, print one line starting with `phase:`** — somebody is watching this and that',
    '  line is all they have to go on until it is done.',
  ].join('\n');
}

function phaseOf(line: string): string | null {
  const plain = line.split('**').join('').trim();
  const bare = plain.replace(/^[-*>#]+/, '').trim();
  const said = bare.toLowerCase().startsWith('phase:') ? bare.slice('phase:'.length).trim() : '';
  return said === '' ? null : said;
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(Math.max(minutes, 1))} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${String(days)} days`;
}

interface LocalRunnerDeps {
  store: Store;
  worktrees: Worktrees;
  sessions: SessionFactory;
  policy: () => LocalRunPolicy;
  claudeCommand: string;
  claudeArgs: string[];
  permissionMode: string;
  defaultBranch: string;
  choicesFor: (originRef: string) => LocalRunChoices;
  reap: ProcessReaper;
  stopTimeoutMs?: number;
  now?: () => number;
  errors: ErrorRecorder;
}

export class LocalRunner extends EventEmitter {
  private session: AgentSession | null = null;
  private runId: string | null = null;
  private inFlight: LocalRunTurn | null = null;
  private tail: string[] = [];
  private stage: string | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly deps: LocalRunnerDeps) {
    super();
  }

  override emit(event: 'changed'): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
  override on(event: 'changed', cb: () => void): this;
  override on(event: string, cb: (...args: unknown[]) => void): this {
    return super.on(event, cb);
  }

  current(): LocalRun | null {
    return this.deps.store.currentLocalRun();
  }

  output(): string[] {
    return [...this.tail];
  }

  phase(): string | null {
    return this.stage;
  }

  turn(): LocalRunTurn | null {
    return this.inFlight;
  }

  holdsSession(): boolean {
    return this.session !== null;
  }

  async start(originRef: string, at?: string): Promise<{ ok: true; run: LocalRun } | { ok: false; error: string }> {
    const instruction = this.deps.policy().instruction.trim();
    if (instruction === '')
      return {
        ok: false,
        error:
          'Nothing is configured to start. Set `localRun.instruction` on the Config page — what you would ' +
          'tell somebody to get this project running on your machine — and try again.',
      };

    const choices = this.deps.choicesFor(originRef);
    if (at !== undefined && !choices.options.some((option) => option.ref === at))
      return {
        ok: false,
        error:
          `${at} is not one of ${originRef}'s own branches, so there is nothing to run there. ` +
          'Pick a part from the panel — what it offers is what this goal has.',
      };
    const ref = at ?? choices.target ?? this.deps.defaultBranch;

    const stopped = this.deps.store.liveLocalRun() !== null;
    await this.stop('superseded by a run of another goal');

    let checkout: { dir: string; commit: string };
    try {
      checkout = await this.deps.worktrees.ensurePreview(ref);
    } catch (err) {
      return {
        ok: false,
        error:
          `Could not prepare a checkout of ${ref}: ${(err as Error).message}` +
          (stopped ? ' — what was running has been stopped.' : ''),
      };
    }

    const { dir, commit } = checkout;
    const url = this.deps.policy().url.trim();
    const run = this.deps.store.beginLocalRun({ originRef, ref, dir, commit, url: url === '' ? null : url });
    this.runId = run.id;
    this.inFlight = 'start';
    this.tail = [];
    this.stage = null;

    const session = this.deps.sessions({
      command: this.deps.claudeCommand,
      args: [...STREAM_TRANSPORT_ARGS, '--permission-mode', this.deps.permissionMode, ...this.deps.claudeArgs],
      cwd: dir,
    });
    this.session = session;
    this.wire(session, run.id);
    try {
      session.start();
    } catch (err) {
      this.settle(run.id, 'failed', `Could not start a session: ${(err as Error).message}`);
      return { ok: false, error: `Could not start a session: ${(err as Error).message}` };
    }
    this.deps.store.markLocalRunPid(run.id, session.pid);
    session.send(`${instruction}\n\n${RUN_RULES}`);
    this.emit('changed');
    return { ok: true, run: this.deps.store.currentLocalRun() ?? run };
  }

  resumeInterrupted():
    | { outcome: 'nothing' }
    | { outcome: 'resumed'; run: LocalRun }
    | { outcome: 'settled'; run: LocalRun; reason: string } {
    const live = this.deps.store.liveLocalRun();
    if (live === null) return { outcome: 'nothing' };
    const give = (reason: string): { outcome: 'settled'; run: LocalRun; reason: string } => {
      this.settle(live.id, 'stopped', `the harness restarted — ${reason}`);
      return { outcome: 'settled', run: live, reason };
    };

    if (live.status === 'stopping')
      return give(
        'it was being taken down when the harness went, so it was not brought back — whatever was left running is still running',
      );

    const instruction = this.deps.policy().resumeInstruction.trim();
    if (instruction === '')
      return give(
        'no resume instruction is configured, so it was not brought back and whatever survived the ' +
          'restart may still be running. Set `localRun.resumeInstruction` on the Config page.',
      );

    if (!existsSync(live.dir)) return give(`its checkout at ${live.dir} is gone`);

    const stale = this.staleness(live);
    if (stale !== null) return give(stale);

    this.deps.store.setLocalRunStatus(live.id, 'starting', 'the harness restarted; this run is being brought back');
    this.deps.store.markLocalRunInterrupted(live.id, null);
    this.runId = live.id;
    this.inFlight = 'start';
    this.tail = [];
    this.stage = null;

    const session = this.deps.sessions({
      command: this.deps.claudeCommand,
      args: [...STREAM_TRANSPORT_ARGS, '--permission-mode', this.deps.permissionMode, ...this.deps.claudeArgs],
      cwd: live.dir,
    });
    this.session = session;
    this.wire(session, live.id);
    try {
      session.start();
    } catch (err) {
      this.settle(live.id, 'failed', `could not start a session to bring it back: ${(err as Error).message}`);
      return { outcome: 'settled', run: live, reason: `a session could not be started: ${(err as Error).message}` };
    }
    this.deps.store.markLocalRunPid(live.id, session.pid);
    session.send(`${instruction}

${RESUME_RULES}`);
    this.emit('changed');
    return { outcome: 'resumed', run: this.deps.store.currentLocalRun() ?? live };
  }

  private staleness(live: LocalRun): string | null {
    const windowMs = this.deps.policy().resumeWindowMs;
    if (!Number.isFinite(windowMs) || windowMs <= 0) return null;

    const stamp = live.interruptedAt ?? live.lastSeenAt;
    if (stamp === null)
      return (
        'nothing recorded when it was interrupted or when it was last held, so how long ago that was is ' +
        'not known and it was not brought back. Whatever survived may still be running.'
      );
    const at = Date.parse(stamp);
    if (Number.isNaN(at)) return 'when it was interrupted was not readable, so it was not brought back';

    const now = (this.deps.now ?? Date.now)();
    const ageMs = now - at;
    if (ageMs <= windowMs) return null;
    const what = live.interruptedAt === null ? 'the harness was last holding it' : 'it was interrupted';
    return (
      `${what} ${describeAge(ageMs)} ago, longer than the ${describeAge(windowMs)} a run may be ` +
      'brought back within, so it was not brought back — start it again when you want it. Whatever survived ' +
      'may still be running. `localRun.resumeWindowMs` on the Config page is what sets that.'
    );
  }

  noteAlive(): void {
    if (this.runId === null) return;
    this.deps.store.markLocalRunSeen(this.runId, new Date((this.deps.now ?? Date.now)()).toISOString());
  }

  send(text: string): { ok: true } | { ok: false; error: string } {
    const message = text.trim();
    if (message === '') return { ok: false, error: 'Nothing to send.' };
    const live = this.deps.store.liveLocalRun();
    if (live === null) return { ok: false, error: 'Nothing is running locally, so there is no session to tell.' };
    if (live.status === 'stopping' || this.stopping !== null)
      return { ok: false, error: 'It is being stopped — there is nothing to tell it now.' };
    if (live.status === 'starting')
      return { ok: false, error: 'It is still coming up. Wait for the start to finish, then say it.' };
    if (this.inFlight !== null)
      return { ok: false, error: `The session is busy (${this.inFlight}). Wait for that turn to end, then say it.` };
    const session = this.session;
    if (session === null)
      return {
        ok: false,
        error:
          'The harness restarted and nothing holds this environment, so there is no session to tell. ' +
          'Stop it and start it again.',
      };
    if (!session.recordsSentMessages) {
      const at = new Date((this.deps.now ?? Date.now)()).toISOString();
      this.takeIn(renderBlocks([{ type: HUMAN_BLOCK, text: message }], at));
    }
    this.inFlight = 'message';
    session.send(message);
    this.emit('changed');
    return { ok: true };
  }

  async refresh(): Promise<
    { ok: true; run: LocalRun; moved: { from: string | null; to: string } } | { ok: false; error: string }
  > {
    const live = this.deps.store.liveLocalRun();
    if (live === null) return { ok: false, error: 'Nothing is running locally, so there is nothing to refresh.' };
    if (live.status === 'stopping' || this.stopping !== null)
      return { ok: false, error: 'It is being stopped — there is nothing to refresh.' };
    if (live.status !== 'running')
      return { ok: false, error: 'It is still coming up. Wait for the start to finish, then refresh.' };
    if (this.inFlight !== null)
      return { ok: false, error: `The session is busy (${this.inFlight}). Wait for that turn to end, then refresh.` };

    let next: string;
    try {
      next = await this.deps.worktrees.previewCommit(live.ref);
    } catch (err) {
      return { ok: false, error: `Could not resolve ${live.ref}: ${(err as Error).message}` };
    }
    if (next === live.commit)
      return {
        ok: false,
        error: `The checkout is already at the tip of ${live.ref} (${next.slice(0, 7)}); there is nothing to pick up.`,
      };

    try {
      await this.deps.worktrees.ensurePreview(live.ref);
    } catch (err) {
      return {
        ok: false,
        error:
          `Could not move the checkout to ${next.slice(0, 7)}: ${(err as Error).message}. ` +
          'The tree may be part-reset — stop the run and start it again.',
      };
    }
    const still = this.deps.store.liveLocalRun();
    if (still === null || still.id !== live.id || still.status !== 'running' || this.stopping !== null)
      return { ok: false, error: 'The run was stopped while the checkout was being moved.' };

    this.deps.store.setLocalRunCommit(live.id, next);
    const moved = { from: live.commit, to: next };
    const session = this.session;
    if (session === null) {
      this.deps.store.setLocalRunStatus(
        live.id,
        'running',
        `the checkout moved to ${next.slice(0, 7)}, but nothing holds this environment so nothing was told to ` +
          'restart — stop it and start it again to see the change',
      );
      this.emit('changed');
      return { ok: true, run: this.deps.store.currentLocalRun() ?? live, moved };
    }
    const instruction = this.deps.policy().refreshInstruction.trim();
    this.stage = null;
    this.inFlight = 'refresh';
    session.send(
      `${instruction}${instruction === '' ? '' : '\n\n'}${refreshRules(live.ref, live.commit, next, instruction === '')}`,
    );
    this.emit('changed');
    return { ok: true, run: this.deps.store.currentLocalRun() ?? live, moved };
  }

  async stop(note = 'stopped from the cockpit'): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const live = this.deps.store.liveLocalRun();
    if (live === null) {
      this.stopSession();
      return;
    }
    this.stopping = this.runStop(live, note).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  stopFast(note = 'the harness shut down'): void {
    const live = this.deps.store.liveLocalRun();
    this.runId = null;
    this.inFlight = null;
    this.stopSession();
    if (live) {
      if (this.deps.policy().resumeInstruction.trim() === '')
        this.settle(
          live.id,
          'stopped',
          this.deps.policy().stopInstruction.trim() === ''
            ? `${note} — the session was killed, so whatever it started may still be running.`
            : `${note} — the stop instruction was not run on the way down, so whatever it started may still be running.`,
        );
      else {
        this.deps.store.setLocalRunStatus(
          live.id,
          live.status,
          `${note} — it is left standing to be brought back on the next boot.`,
        );
        this.deps.store.markLocalRunInterrupted(live.id, new Date((this.deps.now ?? Date.now)()).toISOString());
      }
    }
    this.emit('changed');
  }

  private async runStop(live: LocalRun, note: string): Promise<void> {
    this.deps.store.setLocalRunStatus(live.id, 'stopping');
    this.runId = null;
    this.inFlight = 'stop';
    this.stage = null;
    this.emit('changed');

    let outcome: string;
    try {
      outcome = await this.carryOutStop(live);
    } catch (err) {
      outcome = `the stop did not complete: ${(err as Error).message}`;
      this.deps.errors.record({ source: 'agent', message: `Local run stop failed: ${(err as Error).message}` });
    }
    this.stopSession();
    this.settle(live.id, 'stopped', `${note} — ${outcome}`);
  }

  private async carryOutStop(live: LocalRun): Promise<string> {
    const instruction = this.deps.policy().stopInstruction.trim();
    if (instruction === '')
      return (
        'no stop instruction is configured, so the session was killed but whatever it started may still be ' +
        'running. Set `localRun.stopInstruction` on the Config page.'
      );

    const held = this.session;
    const fresh = held === null ? this.spawnStopSession(live.dir, live.id) : null;
    const session = held ?? fresh;
    if (session === null) return 'nothing could be told to stop it, and the session that started it is gone';
    try {
      const ended = this.turnEnds(session);
      session.send(`${instruction}\n\n${held === null ? STOP_RULES_ALONE : STOP_RULES}`);
      const how = await ended;
      if (how === 'timeout')
        return `the stop did not finish within ${String(Math.round(this.stopTimeoutMs() / 1000))}s, so the session was killed — check for anything it left running`;
      if (how === 'failed') return `the session failed while stopping it: ${this.lastWords() ?? 'no reason given'}`;
      return this.lastWords() ?? 'the session reported it had stopped';
    } finally {
      if (fresh !== null) {
        if (fresh.pid !== null) this.deps.reap(fresh.pid);
        try {
          fresh.kill();
        } catch (err) {
          this.deps.errors.record({
            source: 'agent',
            message: `Could not close the session that stopped the local run: ${(err as Error).message}`,
          });
        }
      }
    }
  }

  private spawnStopSession(dir: string, runId: string): AgentSession | null {
    try {
      const session = this.deps.sessions({
        command: this.deps.claudeCommand,
        args: [...STREAM_TRANSPORT_ARGS, '--permission-mode', this.deps.permissionMode, ...this.deps.claudeArgs],
        cwd: dir,
      });
      this.absorb(session, runId);
      session.start();
      return session;
    } catch (err) {
      this.deps.errors.record({
        source: 'agent',
        message: `Could not start a session to stop the local run: ${(err as Error).message}`,
      });
      return null;
    }
  }

  private turnEnds(session: AgentSession): Promise<'ended' | 'failed' | 'timeout'> {
    return new Promise((resolve) => {
      const settle = (how: 'ended' | 'failed' | 'timeout') => () => {
        clearTimeout(timer);
        for (const event of TURN_ENDED) session.off(event, onEnded);
        session.off('failed', onFailed);
        session.off('exit', onFailed);
        resolve(how);
      };
      const onEnded = settle('ended');
      const onFailed = settle('failed');
      const timer = setTimeout(settle('timeout'), this.stopTimeoutMs());
      for (const event of TURN_ENDED) session.on(event, onEnded);
      session.on('failed', onFailed);
      session.on('exit', onFailed);
    });
  }

  private stopTimeoutMs(): number {
    return this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  }

  private stopSession(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    if (session.pid !== null) this.deps.reap(session.pid);
    try {
      session.kill();
    } catch (err) {
      this.deps.errors.record({ source: 'agent', message: `Could not stop the local run: ${(err as Error).message}` });
    }
  }

  private absorb(session: AgentSession, runId: string): void {
    let last: AgentUsage | null = null;
    session.on('usage', (usage: AgentUsage) => {
      const since = (now: number | null, before: number | null): number | null =>
        now === null ? null : Math.max(0, now - (before ?? 0));
      this.deps.store.addLocalRunUsage(runId, {
        costUsd: since(usage.costUsd, last?.costUsd ?? null),
        inputTokens: since(usage.inputTokens, last?.inputTokens ?? null),
        outputTokens: since(usage.outputTokens, last?.outputTokens ?? null),
        cacheReadTokens: since(usage.cacheReadTokens, last?.cacheReadTokens ?? null),
        cacheCreationTokens: since(usage.cacheCreationTokens, last?.cacheCreationTokens ?? null),
        numTurns: since(usage.numTurns, last?.numTurns ?? null),
      });
      last = usage;
      this.emit('changed');
    });
    session.on('output', (delta: string) => this.takeIn(delta));
  }

  private takeIn(delta: string): void {
    for (const line of delta.split('\n')) {
      if (line.trim() === '') continue;
      this.tail.push(line);
      const said = phaseOf(line);
      if (said !== null) this.stage = said;
    }
    if (this.tail.length > TAIL_LINES) this.tail = this.tail.slice(-TAIL_LINES);
    this.emit('changed');
  }

  private wire(session: AgentSession, id: string): void {
    this.absorb(session, id);
    const up = (): void => {
      if (this.runId !== id) return;
      this.deps.store.setLocalRunStatus(id, 'running');
      this.stage = null;
      this.inFlight = null;
      this.emit('changed');
    };
    for (const event of TURN_ENDED) {
      if (event === 'limited')
        session.on(event, () => {
          if (this.runId !== id) return;
          this.deps.errors.record({
            source: 'agent',
            message: 'The local run hit the account usage limit mid-turn; the environment may not be fully up.',
          });
          up();
        });
      else session.on(event, up);
    }
    session.on('failed', () => {
      if (this.runId !== id) return;
      this.settle(id, 'failed', this.lastWords() ?? 'the session failed');
    });
    session.on('exit', (code: number) => {
      if (this.runId !== id) return;
      const live = this.deps.store.liveLocalRun();
      if (!live || live.id !== id) return;
      this.settle(id, 'failed', `the session holding the environment exited (${code})`);
    });
  }

  private settle(id: string, status: 'stopped' | 'failed', note: string): void {
    this.deps.store.setLocalRunStatus(id, status, note);
    this.stage = null;
    this.inFlight = null;
    if (this.runId === id) this.runId = null;
    this.emit('changed');
  }

  private lastWords(): string | null {
    return this.tail.length > 0 ? (this.tail[this.tail.length - 1] ?? null) : null;
  }
}
