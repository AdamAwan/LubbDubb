import { EventEmitter } from 'node:events';
import { STREAM_TRANSPORT_ARGS } from '../agents/agentProtocol.js';
import type { AgentSession, SessionFactory } from '../agents/session.js';
import type { ProcessReaper } from '../agents/processTree.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import type { LocalRun } from '../types.js';
import type { LocalRunPolicy } from './policy.js';

/** How many lines of the session's output the panel gets. */
const TAIL_LINES = 200;

/**
 * What the session is told on top of the operator's own instruction, appended and
 * never interpolated — the prompt templates' rule, for their reason: an operator
 * writing down how their project starts has no way to know these four things, and
 * an instruction that had to remember them would be one edit from dropping one.
 *
 * Every line is here because leaving it out breaks the run in a way that looks like
 * something else:
 *
 * - **Background, and stay alive.** The dev server is a descendant of this session.
 *   A session that runs the server in the foreground blocks its own turn and then
 *   times out; one that starts it and exits takes the server with it.
 * - **Do not stop it**, because the turn ending is not the run ending.
 * - **Do not commit.** The checkout is detached at somebody else's commit.
 * - **Say where it landed**, which is the one thing the harness cannot observe and
 *   the operator most wants — `localRun.url` is what was *configured*, not what
 *   happened.
 */
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
].join('\n');

interface LocalRunnerDeps {
  store: Store;
  worktrees: Worktrees;
  /**
   * The same factory the fleet's agents are built from, so `agentMode` and the test
   * fakes apply here without this module knowing either exists.
   */
  sessions: SessionFactory;
  /**
   * The live policy, **by reference** — `LIVE_ARMS` assigns a new object onto the
   * running config, so a function is what makes an instruction corrected in the
   * cockpit apply to the next start rather than the next restart.
   */
  policy: () => LocalRunPolicy;
  claudeCommand: string;
  claudeArgs: string[];
  permissionMode: string;
  /** Where a goal with no branch of its own is run from. */
  defaultBranch: string;
  /** Which ref a goal's work is on, or null to fall back to the integration branch. */
  refFor: (originRef: string) => string | null;
  /**
   * Kills the session's whole process **subtree**. The dev server is a descendant,
   * not the process itself, so a reaper that only signalled the child would leave
   * the port held and the checkout unremovable.
   */
  reap: ProcessReaper;
  errors: ErrorRecorder;
}

/**
 * The one local run: the machine's dev environment, which goal's code is in it, and
 * the process holding it up.
 *
 * **One at a time, and the store is what enforces it** —
 * `Store.beginLocalRun` ends whatever was live in the same transaction that writes
 * the new row. This class kills the old session when that happens, but it is not
 * the thing keeping the count at one: a runner that checked first and wrote second
 * would leave two servers on one port with the cockpit drawing one of them.
 *
 * **Nothing here polls the application.** `running` means the session finished its
 * turn without failing and its process is still alive; the URL is drawn as a link to
 * try rather than as a reading. A readiness probe is the honest way to close that
 * gap and is deliberately a separate change.
 */
export class LocalRunner extends EventEmitter {
  private session: AgentSession | null = null;
  private runId: string | null = null;
  private tail: string[] = [];

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

  /** The run to draw, live or last, straight from the store. */
  current(): LocalRun | null {
    return this.deps.store.currentLocalRun();
  }

  /** The last lines the session printed, for the panel. Empty before the first start. */
  output(): string[] {
    return [...this.tail];
  }

  /**
   * Start `originRef`'s work in the local environment, stopping whatever was there.
   *
   * A refusal is a returned reason rather than a throw, because both callers — the
   * route and the desktop tool — hand it straight back to a person.
   */
  async start(originRef: string): Promise<{ ok: true; run: LocalRun } | { ok: false; error: string }> {
    const instruction = this.deps.policy().instruction.trim();
    if (instruction === '')
      return {
        ok: false,
        error:
          'Nothing is configured to start. Set `localRun.instruction` on the Config page — what you would ' +
          'tell somebody to get this project running on your machine — and try again.',
      };

    const ref = this.deps.refFor(originRef) ?? this.deps.defaultBranch;
    let dir: string;
    try {
      // Before the store write: a checkout that cannot be prepared is not a run, and
      // a row saying `starting` for a directory that was never made is a row the
      // panel would draw as an environment coming up.
      dir = await this.deps.worktrees.ensurePreview(ref);
    } catch (err) {
      return { ok: false, error: `Could not prepare a checkout of ${ref}: ${(err as Error).message}` };
    }

    // Stop the old session *before* the write that supersedes its row, so the
    // process and the record go together. The other order leaves a killed session's
    // row live for as long as the kill takes.
    this.stopSession();
    const url = this.deps.policy().url.trim();
    const run = this.deps.store.beginLocalRun({ originRef, ref, dir, url: url === '' ? null : url });
    this.runId = run.id;
    this.tail = [];

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

  /** Stop the run, if one is going. Idempotent — stopping nothing is not a failure. */
  stop(note = 'stopped from the cockpit'): void {
    const live = this.deps.store.liveLocalRun();
    this.stopSession();
    if (live) this.settle(live.id, 'stopped', note);
    this.emit('changed');
  }

  /**
   * Kill the session and forget it, without touching the row.
   *
   * Separate from {@link stop} because a start supersedes the old row itself, in the
   * transaction that writes the new one — this is the process half alone, and
   * calling both would stamp the superseded row twice.
   */
  private stopSession(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    // Reap first. Descendants are resolved through the root pid, so a reap *after*
    // the process dies finds nothing — and the descendant here is the dev server.
    if (session.pid !== null) this.deps.reap(session.pid);
    try {
      session.kill();
    } catch (err) {
      this.deps.errors.record({ source: 'agent', message: `Could not stop the local run: ${(err as Error).message}` });
    }
  }

  private wire(session: AgentSession, id: string): void {
    session.on('output', (delta: string) => {
      for (const line of delta.split('\n')) {
        if (line.trim() === '') continue;
        this.tail.push(line);
      }
      if (this.tail.length > TAIL_LINES) this.tail = this.tail.slice(-TAIL_LINES);
      this.emit('changed');
    });
    // The turn ending is the environment being up, which is the whole of what the
    // harness knows: `done` and `waiting` are both "it stopped talking and did not
    // fail", and neither means the process has gone.
    const up = (): void => {
      if (this.runId !== id) return;
      this.deps.store.setLocalRunStatus(id, 'running');
      this.emit('changed');
    };
    session.on('done', up);
    session.on('waiting', up);
    session.on('failed', () => this.settle(id, 'failed', this.lastWords() ?? 'the session failed'));
    session.on('exit', (code: number) => {
      // An exit is only a failure while the run is meant to be up. A stop kills the
      // session on purpose, and its row is already settled by then.
      if (this.runId !== id) return;
      const live = this.deps.store.liveLocalRun();
      if (!live || live.id !== id) return;
      this.settle(id, 'failed', `the session holding the environment exited (${code})`);
    });
  }

  private settle(id: string, status: 'stopped' | 'failed', note: string): void {
    this.deps.store.setLocalRunStatus(id, status, note);
    if (this.runId === id) this.runId = null;
    this.emit('changed');
  }

  /** The last thing the session said, which is what a failure is best explained by. */
  private lastWords(): string | null {
    return this.tail.length > 0 ? (this.tail[this.tail.length - 1] ?? null) : null;
  }
}
