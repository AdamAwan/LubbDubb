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

/** How many lines of the session's output the panel gets. */
const TAIL_LINES = 200;

/**
 * What the session is told on top of the operator's own instruction, appended and
 * never interpolated. Each line is here because leaving it out breaks the run in a
 * way that looks like something else: run in the background (the dev server is a
 * descendant of this session), do not stop it, do not commit, say where it landed,
 * and say each step before taking it. → `docs/spec/23-local-runs.md`
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
 * What a session bringing an **interrupted** run back is told, appended to the
 * operator's resume instruction. It is told outright that what it finds still
 * running is its predecessor's work, or it reads the held ports as a collision and
 * either brings up a second stack or gives up.
 */
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

/**
 * How long a stop instruction is given before the session is killed anyway. There has
 * to be a bound — a swap waits for the stop — and it is generous, because the honest
 * failure here is "killed something that was halfway down".
 */
const STOP_TIMEOUT_MS = 120_000;

/**
 * Every event that means "the turn ended and the session did not fail". Declared once:
 * a listener naming a subset misses the one the runtime actually emits — see `wire`.
 */
const TURN_ENDED = ['done', 'waiting', 'stalled', 'limited'] as const;

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
 * The same, for a session that did **not** start the environment. It is told that
 * outright: left to infer it, it reports there is nothing to do, which is the one
 * answer that leaves the containers up.
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
 * What the session holding a **running** environment is told when the checkout under
 * it has moved, after the operator's own `localRun.refreshInstruction`. A function
 * because the harness's own facts are part of it; nothing here is operator-
 * overridable, so this is not the interpolation the prompt-template rule bans.
 */
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

/**
 * The stage out of a line the session printed, or null if it was not one. Tolerant of
 * decoration, since what comes back is a model's prose — but it never *guesses*: a
 * line that does not say `phase` is output, and a made-up caption is worse than none.
 */
function phaseOf(line: string): string | null {
  const plain = line.split('**').join('').trim();
  const bare = plain.replace(/^[-*>#]+/, '').trim();
  const said = bare.toLowerCase().startsWith('phase:') ? bare.slice('phase:'.length).trim() : '';
  return said === '' ? null : said;
}

/** A span of milliseconds in the words an operator would use, rounded to the coarsest unit that still says something. */
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
  /**
   * The same factory the fleet's agents are built from, so `agentMode` and the test
   * fakes apply here without this module knowing either exists.
   */
  sessions: SessionFactory;
  /**
   * The live policy, **by reference** — a function, so an instruction corrected in the
   * cockpit applies to the next start rather than the next restart.
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
   * Kills the session's whole process **subtree**. The dev server is a descendant, so
   * signalling only the child leaves the port held and the checkout unremovable.
   */
  reap: ProcessReaper;
  /** How long a stop instruction is given before the kill. Injected for tests; unset means {@link STOP_TIMEOUT_MS}. */
  stopTimeoutMs?: number;
  /** The clock the resume window is measured against. Injected for tests; unset means `Date.now`. */
  now?: () => number;
  errors: ErrorRecorder;
}

/**
 * The one local run: the machine's dev environment, which goal's code is in it, and
 * the process holding it up.
 *
 * **One at a time, and the store enforces it** — `Store.beginLocalRun` ends whatever
 * was live in the transaction that writes the new row; this class only kills the old
 * session. **Nothing here polls the application**: `running` means the session
 * finished a turn without failing and its process is alive, and the port and
 * staleness probes belong to `LocalRunWatch` so this class never blocks on a socket.
 * → `docs/spec/23-local-runs.md`
 */
export class LocalRunner extends EventEmitter {
  private session: AgentSession | null = null;
  private runId: string | null = null;
  /**
   * The turn in flight on the held session, or null between turns. Not the row's
   * status: a `running` environment can have a refresh or message turn on top of it.
   */
  private inFlight: LocalRunTurn | null = null;
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
   * What the session last said it was doing, or null. On the snapshot rather than
   * re-derived by the cockpit, so one rule decides what counts as a stage. Cleared
   * when the run comes up or settles: a stage is a claim about work in flight.
   */
  phase(): string | null {
    return this.stage;
  }

  /**
   * Which turn the held session is in the middle of, or null between turns — what says
   * it for a refresh or a message, both of which happen on top of a `running` row.
   */
  turn(): LocalRunTurn | null {
    return this.inFlight;
  }

  /**
   * Whether this process holds a session for the live run — false after a restart that
   * could not bring it back, and during a stop driven by a fresh session.
   */
  holdsSession(): boolean {
    return this.session !== null;
  }

  /**
   * Start `originRef`'s work in the local environment, stopping whatever was there.
   * `at` runs an earlier part of the same goal, and is **checked against that goal's
   * own part branches** — without the check this is a way to check out any ref in the
   * repository through an HTTP route. A refusal is a returned reason, never a throw.
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

    // Everything that could refuse has refused by now: the next line takes the
    // operator's environment down.
    const stopped = this.deps.store.liveLocalRun() !== null;
    await this.stop('superseded by a run of another goal');

    let checkout: { dir: string; commit: string };
    try {
      // **After** the stop, and that order is load-bearing: the stop instruction runs
      // in this checkout, and `ensurePreview` is a `reset --hard` and a `clean -fd` on
      // it. The cost is that a checkout that cannot be prepared fails with the previous
      // environment already gone, so the refusal says so.
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

  /**
   * Bring back the run a previous harness left behind, or settle the row if it cannot
   * be brought back. The boot sweep, and the only thing that clears a live row at
   * startup. **A row saying `running` at boot is not a run** — its pid is a dead
   * parent's — but a shutdown cannot touch a container, so what survived is attached
   * to via a third instruction ({@link LocalRunPolicy.resumeInstruction}).
   *
   * **Called from `main.ts`, below the shutdown handlers**, never from `buildSystem`:
   * it spawns a process. Synchronous and deliberately preparing no checkout —
   * `ensurePreview` resets and cleans, which would pull the project out from under
   * containers that are still up. → `docs/spec/21-self-update.md`
   */
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

    // A `stopping` row is an operator who asked for this environment to go away;
    // bringing it back answers the opposite of the last thing they said.
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

    // Checked rather than discovered through a spawn: a bad `cwd` surfaces async, which
    // would leave this method reporting a resume that never happened.
    if (!existsSync(live.dir)) return give(`its checkout at ${live.dir} is gone`);

    // Last, because it is the least specific reason of the four: a run whose checkout
    // has gone is told that rather than told it is old.
    const stale = this.staleness(live);
    if (stale !== null) return give(stale);

    this.deps.store.setLocalRunStatus(live.id, 'starting', 'the harness restarted; this run is being brought back');
    // The stamp described an interruption now being answered. Left on, the next hard
    // crash would be dated to this one and refused as hours old.
    this.deps.store.markLocalRunInterrupted(live.id, null);
    this.runId = live.id;
    this.inFlight = 'start';
    // Tail and stage belong to the dead session; kept, they would caption this bring-up.
    this.tail = [];
    this.stage = null;

    const session = this.deps.sessions({
      command: this.deps.claudeCommand,
      args: [...STREAM_TRANSPORT_ARGS, '--permission-mode', this.deps.permissionMode, ...this.deps.claudeArgs],
      cwd: live.dir,
    });
    this.session = session;
    // The bring-up's handlers: a turn ending here means the environment is up again.
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

  /**
   * Why this run is too old to bring back, or null if it is not. **A resume is for a
   * restart** — for a harness that was off overnight there is nothing left to attach
   * to, and the boot would spend a session on an environment nobody asked for.
   * **An unstamped row is unknown, and unknown is refused**; `startedAt` is not a
   * stand-in for it.
   */
  private staleness(live: LocalRun): string | null {
    const windowMs = this.deps.policy().resumeWindowMs;
    // No bound at all is a supported setting, for an environment that survives anything.
    if (!Number.isFinite(windowMs) || windowMs <= 0) return null;

    // The shutdown's own stamp first, the last pulse that held the run behind it. The
    // fallback matters: End task and a power cut run no line, so `interruptedAt` is
    // null on exactly the crashes a resume is most wanted for.
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
    // Said as "last held" where that is what the figure is.
    const what = live.interruptedAt === null ? 'the harness was last holding it' : 'it was interrupted';
    return (
      `${what} ${describeAge(ageMs)} ago, longer than the ${describeAge(windowMs)} a run may be ` +
      'brought back within, so it was not brought back — start it again when you want it. Whatever survived ' +
      'may still be running. `localRun.resumeWindowMs` on the Config page is what sets that.'
    );
  }

  /**
   * Record that this harness is still holding the run. **Called from the pulse**, and
   * what makes the resume window survive a force close — `stopFast` covers Ctrl-C and
   * an upgrade, and nothing else. **Only while `runId` is set**: that field is this
   * process's claim on the row, and stamping "whatever is live" would date a row this
   * harness refused. Deliberately above the pulse's recovery hold — it says the
   * harness is alive, not that a cycle did work.
   */
  noteAlive(): void {
    if (this.runId === null) return;
    // This runner's clock, never the store's: `staleness` measures against the same one.
    this.deps.store.markLocalRunSeen(this.runId, new Date((this.deps.now ?? Date.now)()).toISOString());
  }

  /**
   * Type into the session holding the environment — `AgentManager.respond` for the one
   * session that is not an agent. Refused outside the states where it means something:
   * nothing up, being stopped, still coming up, another turn in flight, or nothing
   * holding the session. **Echoed into the tail**, because the stream runtime renders
   * only what comes back.
   */
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

  /**
   * Move the checkout to the tip of the run's own ref and tell the session what moved.
   *
   * **Resolved before anything is touched**: a refresh at the tip must refuse from
   * `previewCommit`, since `ensurePreview` would already have reset and cleaned the
   * tree to move it nowhere. **The reset under a running server is the accepted
   * hazard**, which is why the control is a click and never automatic; a tree that
   * will not reset leaves the recorded commit alone. With nothing holding the session
   * the checkout still moves and the note says nobody was told.
   * → [23](../../docs/spec/23-local-runs.md)
   */
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
    // Two awaits have passed; the run may have been stopped or swapped under them.
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

  /**
   * Stop the run, if one is going: the stop **instruction** first, then the reap.
   * **A dev environment is not a process tree** — a reap cannot touch a Docker
   * container — which is why this is a turn and not a signal. Idempotent, and **one
   * stop at a time**: every caller awaits the same promise.
   */
  async stop(note = 'stopped from the cockpit'): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const live = this.deps.store.liveLocalRun();
    if (live === null) {
      // Nothing recorded as up, so nothing to instruct — but a held session is ours to clean up.
      this.stopSession();
      return;
    }
    this.stopping = this.runStop(live, note).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /**
   * Stop without the instruction: reap, kill, settle. For shutdown only — waiting for a
   * model turn on Ctrl-C or the upgrade handoff would hang the one path that must not
   * hang, so the environment may outlive the harness and the note says so.
   * → [21](../../docs/spec/21-self-update.md)
   */
  stopFast(note = 'the harness shut down'): void {
    const live = this.deps.store.liveLocalRun();
    // Before the kill: the wired `exit` handler would settle this as `failed`, and the
    // next boot would refuse to bring that row back. Here the session dying *is* the shutdown.
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
      // Otherwise the row is **left live on purpose**: nothing else records that there
      // is an environment to come back to, and the status is left exactly as it was.
      else {
        this.deps.store.setLocalRunStatus(
          live.id,
          live.status,
          `${note} — it is left standing to be brought back on the next boot.`,
        );
        // **The only line that dates the interruption**, and the next boot's resume is
        // judged on it. A stamp nobody wrote reads as unknown rather than recent, so
        // forgetting it refuses the resume rather than granting a stale one.
        this.deps.store.markLocalRunInterrupted(live.id, new Date((this.deps.now ?? Date.now)()).toISOString());
      }
    }
    this.emit('changed');
  }

  /**
   * The stop itself: mark it `stopping`, get the instruction carried out, reap, settle.
   * `stopping` is a live status because a run being taken down still holds the
   * environment, so the store must go on refusing a second run beside it.
   */
  private async runStop(live: LocalRun, note: string): Promise<void> {
    this.deps.store.setLocalRunStatus(live.id, 'stopping');
    // The stop turn ends in a `done` like any other, which `up()` would read as "the
    // environment is up". Dropping the id keeps the bring-up's handlers out of it.
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
    // The reap comes **after** the instruction and happens either way.
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

    // The session that brought it up if it is still there; otherwise a fresh one in
    // the same checkout, or a swap starts a second stack on the same ports.
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
      // A session spawned only to run the stop is ours to take down here.
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
  private spawnStopSession(dir: string, runId: string): AgentSession | null {
    try {
      const session = this.deps.sessions({
        command: this.deps.claudeCommand,
        args: [...STREAM_TRANSPORT_ARGS, '--permission-mode', this.deps.permissionMode, ...this.deps.claudeArgs],
        cwd: dir,
      });
      // Output and usage but not `wire`: the bring-up's handlers would read this
      // session's turn ending as the environment coming up.
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

  /**
   * The next turn ending, bounded — a stop that never finishes must not leave a harness
   * that can never start anything again; on the timeout the caller kills the session
   * and says the stop was not confirmed. Four events mean "ended", and `stalled` is
   * the one that actually fires: a local run's session carries no protocol prompt, so
   * it never prints a sentinel.
   */
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

  /**
   * Kill the session and forget it, without touching the row — the process half alone,
   * since a start supersedes the old row in the transaction that writes the new one.
   */
  private stopSession(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    // Reap first: descendants resolve through the root pid, so a reap after the
    // process dies finds nothing — and the descendant here is the dev server.
    if (session.pid !== null) this.deps.reap(session.pid);
    try {
      session.kill();
    } catch (err) {
      this.deps.errors.record({ source: 'agent', message: `Could not stop the local run: ${(err as Error).message}` });
    }
  }

  /**
   * Take a session's output into the tail and the stage, and its usage onto the row.
   * Shared by the bring-up session and by one spawned only to take it down.
   */
  private absorb(session: AgentSession, runId: string): void {
    // Cumulative per session, held in this closure. The row accumulates across
    // sessions, so what it needs from each is the difference since that session's own
    // last report. A PTY session emits none of this and the run stays unmeasured.
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

  /**
   * Lines into the tail and the newest `phase:` among them into the stage. One path for
   * printed and typed alike, so an echoed message rolls off the top with everything else.
   */
  private takeIn(delta: string): void {
    for (const line of delta.split('\n')) {
      if (line.trim() === '') continue;
      this.tail.push(line);
      // Newest wins, and a non-phase line leaves the last one standing.
      const said = phaseOf(line);
      if (said !== null) this.stage = said;
    }
    if (this.tail.length > TAIL_LINES) this.tail = this.tail.slice(-TAIL_LINES);
    this.emit('changed');
  }

  private wire(session: AgentSession, id: string): void {
    this.absorb(session, id);
    // The turn ending is the environment being up, which is the whole of what the
    // harness knows. `stalled` is the one a local run actually produces — no protocol
    // prompt, so no sentinel — and listening for only a subset left the row in
    // `starting` for the life of the environment. A refresh or message turn ends here too.
    const up = (): void => {
      if (this.runId !== id) return;
      this.deps.store.setLocalRunStatus(id, 'running');
      // Nothing in flight, so no stage: left standing it would caption a finished bring-up forever.
      this.stage = null;
      this.inFlight = null;
      this.emit('changed');
    };
    for (const event of TURN_ENDED) {
      if (event === 'limited')
        session.on(event, () => {
          if (this.runId !== id) return;
          // The turn is over because the account is, not because the work is: the row
          // says `running` and the record says why that may be less true than it looks.
          this.deps.errors.record({
            source: 'agent',
            message: 'The local run hit the account usage limit mid-turn; the environment may not be fully up.',
          });
          up();
        });
      else session.on(event, up);
    }
    session.on('failed', () => {
      // Guarded like `exit` below: during a stop `carryOutStop` reports what happened,
      // and two writers settle one row twice.
      if (this.runId !== id) return;
      this.settle(id, 'failed', this.lastWords() ?? 'the session failed');
    });
    session.on('exit', (code: number) => {
      // An exit is only a failure while the run is meant to be up.
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

  /** The last thing the session said, which is what a failure is best explained by. */
  private lastWords(): string | null {
    return this.tail.length > 0 ? (this.tail[this.tail.length - 1] ?? null) : null;
  }
}
