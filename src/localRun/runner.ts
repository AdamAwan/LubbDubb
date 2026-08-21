import { EventEmitter } from 'node:events';
import { STREAM_TRANSPORT_ARGS } from '../agents/agentProtocol.js';
import type { AgentSession, SessionFactory } from '../agents/session.js';
import type { ProcessReaper } from '../agents/processTree.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import type { LocalRun } from '../types.js';
import type { LocalRunChoices } from './ref.js';
import type { LocalRunPolicy } from './policy.js';

/** How many lines of the session's output the panel gets. */
const TAIL_LINES = 200;

/**
 * What the session is told on top of the operator's own instruction, appended and
 * never interpolated — the prompt templates' rule, for their reason: an operator
 * writing down how their project starts has no way to know these five things, and
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
 * - **Say each step before taking it**, prefixed `phase:`. A bring-up is minutes of
 *   work inside one turn, and until that turn ends the harness knows only that it
 *   started — which reads on the glass exactly like a start that has hung.
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
  '- **Before each step, print one line saying what you are about to do, starting with `phase:`** — for',
  '  example `phase: starting the containers`. Somebody is watching this come up and that line is all',
  '  they have to go on until it does. A few words, on a line of its own.',
].join('\n');

/**
 * How long a stop instruction is given before the session is killed anyway.
 *
 * There has to be a bound: a stop that never finishes would otherwise leave a
 * harness that can never start anything again, since a swap waits for it. Generous,
 * because `docker compose down` on a cold machine is not quick and the honest
 * failure here is "killed something that was halfway down".
 */
const STOP_TIMEOUT_MS = 120_000;

/**
 * What the session taking the environment down is told, on top of the operator's own
 * instruction — appended, never interpolated, for the prompt templates' reason.
 */
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

/**
 * The same, for a session that did **not** start the environment — spawned because
 * the one that did is gone (a crash, a restart, a start that failed halfway).
 *
 * It has no memory of the bring-up, so it is told that outright. Left to infer it,
 * a session finds a checkout with nothing of its own running in it and reasonably
 * reports that there is nothing to do — which is the one answer that leaves the
 * containers up.
 */
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

/**
 * The stage out of a line the session printed, or null if it was not one.
 *
 * Tolerant of decoration, because what comes back is a model's prose and a bullet
 * or a bolded label in front of the line is the common case rather than the odd
 * one. What it will not do is *guess*: a line that does not say `phase` is output,
 * and output has its own place on the panel. A stage inferred from whatever the
 * session last happened to say would be a caption the harness made up, which is
 * worse than no caption — it is unfalsifiable from the glass.
 */
function phaseOf(line: string): string | null {
  const plain = line.split('**').join('').trim();
  const bare = plain.replace(/^[-*>#]+/, '').trim();
  const said = bare.toLowerCase().startsWith('phase:') ? bare.slice('phase:'.length).trim() : '';
  return said === '' ? null : said;
}

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
  /**
   * What this goal can be run at — the default and the allow-list, from the one
   * function that decides ({@link localRunChoices}).
   */
  choicesFor: (originRef: string) => LocalRunChoices;
  /**
   * Kills the session's whole process **subtree**. The dev server is a descendant,
   * not the process itself, so a reaper that only signalled the child would leave
   * the port held and the checkout unremovable.
   */
  reap: ProcessReaper;
  /**
   * How long a stop instruction is given before the session is killed anyway.
   * Injected rather than read from the constant so a test can bound it at
   * milliseconds; unset means {@link STOP_TIMEOUT_MS}.
   */
  stopTimeoutMs?: number;
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
  private stage: string | null = null;
  /** The stop in flight, so a swap and a second click wait on one teardown. */
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

  /** The run to draw, live or last, straight from the store. */
  current(): LocalRun | null {
    return this.deps.store.currentLocalRun();
  }

  /** The last lines the session printed, for the panel. Empty before the first start. */
  output(): string[] {
    return [...this.tail];
  }

  /**
   * What the session last said it was doing, or null if it has not said.
   *
   * On the snapshot rather than dug out of {@link output} by the cockpit, for the
   * reason `live` is: which of a session's lines counts as a stage is one rule, and
   * a component re-deriving it could disagree with what the panel's own log shows.
   *
   * Cleared when the run comes up or settles, because a stage is a claim about work
   * in flight and neither has any. An environment that is up, still reading
   * "starting the containers", is the panel describing something that stopped
   * happening — which is exactly the failure this whole field exists to end.
   */
  phase(): string | null {
    return this.stage;
  }

  /**
   * Start `originRef`'s work in the local environment, stopping whatever was there.
   *
   * `at` runs an **earlier part of the same goal** instead of the default — the tip
   * of its stack. It is checked against that goal's own part branches rather than
   * taken as given: the panel offers a choice from a plan, and a ref that is not one
   * of them did not come from the panel. Without the check this method is a way to
   * check out any ref in the repository through an HTTP route.
   *
   * A refusal is a returned reason rather than a throw, because both callers — the
   * route and the desktop tool — hand it straight back to a person.
   */
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

    // Everything that could refuse has refused by now, because the next line takes
    // the operator's environment down: a swap is a stop and a start, and stopping is
    // a turn rather than a signal (see {@link stop}).
    const stopped = this.deps.store.liveLocalRun() !== null;
    await this.stop('superseded by a run of another goal');

    let dir: string;
    try {
      // **After** the stop, and that order is load-bearing: the stop instruction runs
      // *in this checkout* — `docker compose down` reads the compose file that is in
      // it — and `ensurePreview` is a `reset --hard` and a `clean -fd` on the same
      // directory. Preparing first pulls the project out from under the session being
      // asked to shut it down.
      //
      // The cost is that a checkout that cannot be prepared now fails with the
      // previous environment already gone, so the refusal says so rather than leaving
      // an operator to wonder what happened to what they were looking at.
      dir = await this.deps.worktrees.ensurePreview(ref);
    } catch (err) {
      return {
        ok: false,
        error:
          `Could not prepare a checkout of ${ref}: ${(err as Error).message}` +
          (stopped ? ' — what was running has been stopped.' : ''),
      };
    }

    const url = this.deps.policy().url.trim();
    const run = this.deps.store.beginLocalRun({ originRef, ref, dir, url: url === '' ? null : url });
    this.runId = run.id;
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

  /**
   * Stop the run, if one is going: the stop **instruction** first, then the reap.
   *
   * **A dev environment is not a process tree**, which is the whole reason this is a
   * turn and not a signal. Reaping the session's subtree is right and takes the
   * session and its own children with it — and it cannot touch a Docker container,
   * which belongs to the daemon, or anything a start handed to a service. Nothing
   * the harness can send stops those. So the row used to read `stopped` while the
   * containers ran on: an outcome nothing had checked.
   *
   * Idempotent, and **one stop at a time**: every caller — a second click, a swap,
   * the desktop tool — awaits the same promise rather than starting a second
   * teardown of the same environment.
   */
  async stop(note = 'stopped from the cockpit'): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const live = this.deps.store.liveLocalRun();
    if (live === null) {
      // Nothing is recorded as up, so there is nothing to instruct — but a session we
      // are still holding is ours to clean up regardless.
      this.stopSession();
      return;
    }
    this.stopping = this.runStop(live, note).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /**
   * Stop without the instruction: reap, kill, settle.
   *
   * For shutdown, and deliberately not for anything else. The handlers in `main.ts`
   * run on Ctrl-C and on the upgrade handoff, and both want out *now* — an upgrade
   * especially, since it is a restart. Waiting for a model turn there would hang the
   * one path that must not hang, so the environment is allowed to outlive the harness
   * and the note says so: the panel states it on the next boot rather than leaving an
   * operator to find the containers themselves.
   * → [21](../../docs/spec/21-self-update.md)
   */
  stopFast(note = 'the harness shut down'): void {
    const live = this.deps.store.liveLocalRun();
    this.stopSession();
    if (live)
      this.settle(
        live.id,
        'stopped',
        this.deps.policy().stopInstruction.trim() === ''
          ? `${note} — the session was killed, so whatever it started may still be running.`
          : `${note} — the stop instruction was not run on the way down, so whatever it started may still be running.`,
      );
    this.emit('changed');
  }

  /**
   * The stop itself: mark it `stopping`, get the instruction carried out, reap, settle.
   *
   * `stopping` is a live status ({@link LocalRunStatus}) because a run being taken
   * down still holds the environment — the store must go on refusing a second run
   * beside it, and the panel must not offer one.
   */
  private async runStop(live: LocalRun, note: string): Promise<void> {
    this.deps.store.setLocalRunStatus(live.id, 'stopping');
    // The wired handlers are keyed on `runId`, and the stop turn ends in a `done`
    // like any other — which `up()` would read as "the environment is up". Dropping
    // the id is the one switch that keeps the bring-up's handlers out of the teardown.
    this.runId = null;
    this.stage = null;
    this.emit('changed');

    let outcome: string;
    try {
      outcome = await this.carryOutStop(live);
    } catch (err) {
      outcome = `the stop did not complete: ${(err as Error).message}`;
      this.deps.errors.record({ source: 'agent', message: `Local run stop failed: ${(err as Error).message}` });
    }
    // The reap comes **after** the instruction and happens either way: the session
    // and its own children are the harness's to clean up whether or not the
    // instruction managed its half.
    this.stopSession();
    this.settle(live.id, 'stopped', `${note} — ${outcome}`);
  }

  /** Get the stop instruction carried out, and report in one sentence what happened. */
  private async carryOutStop(live: LocalRun): Promise<string> {
    const instruction = this.deps.policy().stopInstruction.trim();
    if (instruction === '')
      return (
        'no stop instruction is configured, so the session was killed but whatever it started may still be ' +
        'running. Set `localRun.stopInstruction` on the Config page.'
      );

    // The session that brought it up if it is still there — it knows what it
    // started, and it is already warm. Otherwise a fresh one in the same checkout,
    // which is the case that hurt most: after a restart the containers are up and
    // the harness holds nothing, so a swap would have started a second stack on the
    // same ports.
    const held = this.session;
    const fresh = held === null ? this.spawnStopSession(live.dir) : null;
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
      // A session spawned only to run the stop is ours to take down here; the held
      // one is reaped by `stopSession` on the way out of `runStop`.
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

  /** A short-lived session in the run's own checkout, for a stop nothing is left holding. */
  private spawnStopSession(dir: string): AgentSession | null {
    try {
      const session = this.deps.sessions({
        command: this.deps.claudeCommand,
        args: [...STREAM_TRANSPORT_ARGS, '--permission-mode', this.deps.permissionMode, ...this.deps.claudeArgs],
        cwd: dir,
      });
      // Its output, but not `wire` — the bring-up's handlers would read this
      // session's turn ending as the environment coming up.
      this.absorb(session);
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

  /**
   * The next turn ending, bounded.
   *
   * The bound is the point: a stop instruction that never finishes must not leave a
   * harness that can never start anything again. On the timeout the caller kills the
   * session anyway and says the stop was not confirmed — which is the honest reading,
   * and a different one from "it stopped".
   */
  private turnEnds(session: AgentSession): Promise<'ended' | 'failed' | 'timeout'> {
    return new Promise((resolve) => {
      const settle = (how: 'ended' | 'failed' | 'timeout') => () => {
        clearTimeout(timer);
        session.off('done', onEnded);
        session.off('waiting', onEnded);
        session.off('failed', onFailed);
        session.off('exit', onFailed);
        resolve(how);
      };
      const onEnded = settle('ended');
      const onFailed = settle('failed');
      const timer = setTimeout(settle('timeout'), this.stopTimeoutMs());
      session.on('done', onEnded);
      session.on('waiting', onEnded);
      session.on('failed', onFailed);
      session.on('exit', onFailed);
    });
  }

  private stopTimeoutMs(): number {
    return this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
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

  /**
   * Take a session's output into the tail and the stage.
   *
   * Shared by the session that brings the environment up and by one spawned only to
   * take it down: a teardown an operator is watching needs the same account of itself
   * as a bring-up, and a stop session whose output went nowhere would leave the panel
   * with nothing to say for the minute it takes.
   */
  private absorb(session: AgentSession): void {
    session.on('output', (delta: string) => {
      for (const line of delta.split('\n')) {
        if (line.trim() === '') continue;
        this.tail.push(line);
        // Newest wins, and a line that is not a phase leaves the last one standing:
        // the session says `phase: installing` and then prints a page of npm output,
        // and "installing" is still the true answer throughout it.
        const said = phaseOf(line);
        if (said !== null) this.stage = said;
      }
      if (this.tail.length > TAIL_LINES) this.tail = this.tail.slice(-TAIL_LINES);
      this.emit('changed');
    });
  }

  private wire(session: AgentSession, id: string): void {
    this.absorb(session);
    // The turn ending is the environment being up, which is the whole of what the
    // harness knows: `done` and `waiting` are both "it stopped talking and did not
    // fail", and neither means the process has gone.
    const up = (): void => {
      if (this.runId !== id) return;
      this.deps.store.setLocalRunStatus(id, 'running');
      // Nothing is in flight any more, so there is no stage. Left standing, the last
      // step of the bring-up would caption a finished one forever.
      this.stage = null;
      this.emit('changed');
    };
    session.on('done', up);
    session.on('waiting', up);
    session.on('failed', () => {
      // Guarded like `exit` below and for the same reason: during a stop this session
      // is being driven by `carryOutStop`, which reports what happened itself. Two
      // writers on one row settle it twice, with whichever lands second as the story.
      if (this.runId !== id) return;
      this.settle(id, 'failed', this.lastWords() ?? 'the session failed');
    });
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
    this.stage = null;
    if (this.runId === id) this.runId = null;
    this.emit('changed');
  }

  /** The last thing the session said, which is what a failure is best explained by. */
  private lastWords(): string | null {
    return this.tail.length > 0 ? (this.tail[this.tail.length - 1] ?? null) : null;
  }
}
