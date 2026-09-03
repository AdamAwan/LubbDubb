import type { ErrorRecorder } from '../errorLog.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { Store } from '../store/store.js';
import { pullFastForward, readBuildStanding, type BuildStanding } from './buildStanding.js';
import {
  applyUpgradeAction,
  autoUpgradeStep,
  buildReading,
  projectPullability,
  upgradability,
  IDLE_INTENT,
  type BuildReading,
  type UpgradeAction,
  type UpgradeTransition,
} from './upgradePlan.js';

/** The environment variable `scripts/serve.ts` sets to announce itself. */
const SUPERVISOR_ENV = 'LUBBDUBB_SUPERVISOR';

/**
 * Where the harness watches its own build, and where a deliberate upgrade is
 * driven from.
 *
 * **The reading is in memory; the intent is in the store.** They look like one
 * subject and are not. The standing is a fact about the outside world with a
 * timestamp on it — cheap to re-take, wrong to trust across a restart, and read by
 * nothing but this process. The intent is a decision an operator made, and its
 * whole reason for existing is to outlive the process that recorded it. Persisting
 * the first would add a table that says something already true; holding the second
 * in memory would lose it at the exact moment it is needed.
 *
 * **This decides no dispatch.** It pauses one — a drain is `RuntimeControl.paused`,
 * the same flag the operator's own pause button writes — and beyond that it writes
 * a row and, when asked, hands off. What happens to the fleet on the way back up is
 * the recovery desk's business, as it is for any restart.
 */
export class UpdateDesk {
  private standing: BuildStanding | null = null;
  private project: BuildStanding | null = null;
  private checking: Promise<void> | null = null;
  private lastCheckedMs = 0;

  /**
   * How this process is asked to go down for an upgrade. Set by `src/server/main.ts`,
   * which owns shutdown; left unset everywhere else, and then an `apply` records the
   * intent and stops there — which is exactly what a test wants to assert, and what
   * an embedded harness with no supervisor should do.
   *
   * @public assigned by `main.ts`, the one place that knows how to exit cleanly.
   */
  onHandoff: (() => void) | null = null;

  constructor(
    private readonly deps: {
      store: Store;
      runtimeControl: RuntimeControl;
      errors: ErrorRecorder;
      remote: string;
      branch: string;
      checkIntervalMs: number;
      /** Whether the desk takes an update itself, rather than waiting to be clicked. */
      autoUpdate: boolean;
      /** How long an automatic drain waits before it interrupts what is left. Zero waits forever. */
      drainDeadlineMs: number;
      /**
       * The *worked* repository, read on this same timer — `config.repoRoot`
       * against its own remote and `defaultBranch`.
       *
       * On the same timer deliberately, and not because it is convenient: these
       * are two `ls-remote`s answering one question an operator asks once ("is
       * anything waiting"), and two independent schedules would put the harness
       * on the network twice as often to tell them apart. Absent, the project
       * reading is null and nothing about the build changes.
       */
      project?: { root: string; remote: string; branch: string };
      /** Injectable so a test can stand in a checkout it controls, or none at all. */
      read?: typeof readBuildStanding;
      /** The same, for the one git *write* on this desk. */
      pull?: typeof pullFastForward;
      now?: () => string;
      /** Injectable for the same reason: a test asserts both arms without setting env. */
      supervised?: boolean;
    },
  ) {}

  private get now(): () => string {
    return this.deps.now ?? (() => new Date().toISOString());
  }

  /** Whether something is there to relaunch this process after it exits. */
  private get supervised(): boolean {
    return this.deps.supervised ?? process.env[SUPERVISOR_ENV] === '1';
  }

  /**
   * One pulse's worth of work: take a reading if one is due, and move a finished
   * drain to `ready`.
   *
   * **Never throws and never blocks the pulse on the network.** A check that is
   * already in flight is joined rather than started again — the interval is longer
   * than any check, but a manual check and a pulse can still collide — and a check
   * that fails lands on the standing as `unavailable` rather than in the fault log:
   * an air-gapped deployment is a deployment, not a fault, and a gauge reading
   * "unknown" says so once instead of every hour.
   *
   * @public called by `Harness.runCycle`, beside the other bookkeeping passes.
   */
  async run(): Promise<void> {
    await this.check(false);
    this.advanceDrain();
    this.advanceAuto();
  }

  /**
   * Take a reading, unless one was taken recently and `force` is not set.
   *
   * The interval is a floor on *network* traffic, not on freshness of the answer:
   * the standing is kept and served from memory in between, so the panel always has
   * something to show and the cost of opening it is zero.
   */
  async check(force: boolean): Promise<BuildStanding> {
    const dueAt = this.lastCheckedMs + this.deps.checkIntervalMs;
    if (!force && this.standing && Date.now() < dueAt) return this.standing;
    // Two callers arriving together take one reading between them. Without this a
    // manual check during a pulse would run `ls-remote` twice for one answer.
    if (this.checking) {
      await this.checking;
      return this.standing ?? unknownStanding(this.now());
    }
    const read = this.deps.read ?? readBuildStanding;
    const project = this.deps.project;
    this.checking = Promise.all([
      read({ remote: this.deps.remote, branch: this.deps.branch, now: this.now }),
      // Not `Promise.all`-fatal: a project reading is a second opinion about a
      // different repository, so its failure is a null beside the build's answer
      // rather than a check that took neither.
      project
        ? read({
            remote: project.remote,
            branch: project.branch,
            now: this.now,
            root: project.root,
            subject: 'the project checkout',
          }).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([standing, projectStanding]) => {
        this.standing = standing;
        this.project = projectStanding;
      })
      .catch((err: Error) => {
        // The reader is written to return `unavailable` rather than throw, so
        // arriving here means it broke rather than the network did — which is
        // worth a fault, unlike an unreachable remote.
        this.deps.errors.record({
          source: 'cycle',
          message: `Self-update check failed: ${err.message}`,
          detail: err.stack ?? null,
        });
        this.standing = unknownStanding(this.now(), `the update check failed: ${err.message}`);
      })
      .finally(() => {
        this.lastCheckedMs = Date.now();
        this.checking = null;
      });
    await this.checking;
    return this.standing ?? unknownStanding(this.now());
  }

  /**
   * A drain that has run dry becomes a handoff that is safe to take.
   *
   * Deliberately *not* the handoff itself. An operator who asked the fleet to wind
   * down has authorized the wind-down; taking the process out from under them the
   * moment the last agent finishes — possibly hours later, possibly while they are
   * reading the cockpit — is a second decision, and it stays theirs.
   */
  private advanceDrain(): void {
    const intent = this.deps.store.readUpgradeIntent();
    if (intent.state !== 'draining') return;
    if (this.deps.store.countLiveAgents() > 0) return;
    this.deps.store.writeUpgradeIntent({ ...intent, state: 'ready' });
  }

  /**
   * `selfUpdate.autoUpdate`: the two clicks, taken on the fleet's behalf.
   *
   * **A bounded loop, not one step a pulse.** A drain that finds an empty fleet is
   * `ready` the moment it is asked for, and making an unattended upgrade sit in a
   * state whose whole meaning is "go now" until the next heartbeat is the same
   * mistake `applyUpgradeAction` already refuses to make for the operator. Three is
   * the length of the longest legal run — drain, ready, apply — so it terminates on
   * the shape of the machine rather than on the count.
   *
   * Every refusal is swallowed on purpose: a build that turned dirty, a tip that
   * moved back, a reading that went unavailable between the check and here are all
   * "not this pulse", and the operator's manual path says the same thing in words
   * on the panel.
   */
  private advanceAuto(): void {
    if (!this.deps.autoUpdate) return;
    for (let i = 0; i < 3; i++) {
      const intent = this.deps.store.readUpgradeIntent();
      const step = autoUpgradeStep({
        intent,
        upgradable: upgradability(this.standing ?? unknownStanding(this.now())),
        live: this.deps.store.countLiveAgents(),
        supervised: this.supervised,
        drainDeadlineMs: this.deps.drainDeadlineMs,
        drainingForMs: drainingForMs(intent, Date.parse(this.now())),
      });
      if (!step) return;
      const result = this.request(step.action, { interrupt: step.interrupt });
      if (!result.ok) return;
      console.log(`[lubbdubb] auto-update: ${step.action} — ${step.why}`);
      // `apply` hands off; there is nothing after it worth deciding.
      if (result.intent.state === 'applying') return;
    }
  }

  /**
   * Carry the operator's own pause across the upgrade's restart.
   *
   * `RuntimeControl` is deliberately not persisted, so every boot seeds `paused`
   * from `config.startPaused` — which is the right answer for a *cold* boot and the
   * wrong one for this restart. An upgrade is one process handing the fleet to the
   * next, and the pause an operator set before it is a live decision that a
   * configured default has no business overruling: theirs would be dropped and the
   * fleet would come back dispatching, while a deployment that starts paused by
   * policy would park a fleet that was running a second ago. Neither is red, and
   * with `autoUpdate` on nobody is at the screen to notice.
   *
   * `pausedByDrain` is already the fact needed — it records whether the *drain* is
   * what paused dispatch — and it is on the one row written to outlive the process.
   * Reading it here is what makes it load-bearing in both directions.
   *
   * Fenced on `applying` for the same reason `settleUpgrade` is: any other state
   * means this restart was not the upgrade's, and the configured default is then
   * exactly the right answer. Returns what the fleet comes back as, or null when
   * this was not an upgrade's restart.
   *
   * @public called by `main.ts`, beside `RecoveryDesk.settleUpgrade`.
   */
  restorePause(): boolean | null {
    const intent = this.deps.store.readUpgradeIntent();
    if (intent.state !== 'applying') return null;
    const paused = !intent.pausedByDrain;
    this.deps.runtimeControl.apply({ paused });
    return paused;
  }

  /** What the gauge and the panel read. Serves the last reading; takes none. */
  reading(): BuildReading {
    return buildReading({
      standing: this.standing ?? unknownStanding(this.now()),
      intent: this.deps.store.readUpgradeIntent(),
      live: this.deps.store.countLiveAgents(),
      supervised: this.supervised,
      project: this.project,
      projectBranch: this.deps.project?.branch,
    });
  }

  /**
   * Fast-forward the project checkout onto its remote branch.
   *
   * **Why the cockpit has a button for somebody else's repository.** The project
   * layer of the config — `lubbdubb.project.json`, the team's committed policy —
   * is read from `repoRoot`, so a clone three days behind is a harness running a
   * config the team has already changed. `src/server/main.ts` watches that file
   * precisely because "it arrives by `git pull`"; this is the pull, and the
   * watcher it was written for picks the change up on its own poll a second or
   * two later. Nothing here reloads the config, and nothing here should: one path
   * applies a config change, and it is the one an operator's own `git pull`
   * already goes through.
   *
   * A refusal is a value with the reason in it, on `request`'s terms — the
   * request was well-formed and the world simply moved.
   *
   * The reading is re-taken **forced** on success, because the whole point of the
   * click was to change the answer and a card still saying "3 commits waiting" is
   * a button that looks like it did nothing.
   */
  async pullProject(): Promise<{ ok: true; build: BuildReading } | { ok: false; error: string }> {
    const target = this.deps.project;
    if (!target) return { ok: false, error: 'no project checkout is being watched' };
    const verdict = projectPullability(this.project, target.branch);
    if (!verdict.can) return { ok: false, error: verdict.blocked ?? 'the project checkout cannot be pulled' };
    const pull = this.deps.pull ?? pullFastForward;
    const result = await pull({ root: target.root, remote: target.remote, branch: target.branch });
    if (!result.ok) return { ok: false, error: result.error };
    await this.check(true);
    return { ok: true, build: this.reading() };
  }

  /**
   * Apply an operator's request. Returns a refusal rather than throwing, so a
   * stale button in a second cockpit reads as a 409 with a reason rather than a 500.
   *
   * The pause is written **after** the transition is accepted and unwritten as part
   * of a cancel, so the flag and the row cannot disagree: every path that sets one
   * sets the other, and a refusal sets neither.
   */
  request(action: UpgradeAction, opts: { interrupt?: boolean } = {}): UpgradeTransition {
    const standing = this.standing ?? unknownStanding(this.now());
    const intent = this.deps.store.readUpgradeIntent();
    const result = applyUpgradeAction(
      intent,
      { action, interrupt: opts.interrupt },
      {
        upgradable: upgradability(standing, this.project),
        live: this.deps.store.countLiveAgents(),
        alreadyPaused: this.deps.runtimeControl.paused,
        targetSha: standing.upstream,
        now: this.now(),
      },
    );
    if (!result.ok) return result;

    if (action === 'cancel') {
      // Only the pause this drain put on. One the operator set themselves outlives
      // the upgrade they cancelled.
      if (intent.pausedByDrain) this.deps.runtimeControl.apply({ paused: false });
    } else {
      this.deps.runtimeControl.apply({ paused: true });
    }
    this.deps.store.writeUpgradeIntent(result.intent);

    // The handoff is last, and only once the row says `applying`: the marker has to
    // be durable *before* the process can go, or a shutdown that wins the race
    // leaves the next boot with interrupted agents and no record that anyone meant it.
    if (result.intent.state === 'applying') this.onHandoff?.();
    return result;
  }

  /**
   * Clear the intent once the upgrade it describes is over — called at boot, after
   * the recovery desk has read it. Idempotent, and safe on a database that never
   * recorded one.
   *
   * @public called by `main.ts` after `RecoveryDesk.settleUpgrade`.
   */
  clearIntent(): void {
    if (this.deps.store.readUpgradeIntent().state === 'idle') return;
    this.deps.store.writeUpgradeIntent(IDLE_INTENT);
  }
}

/**
 * How long the drain in this intent has been waiting, or null when it is not one
 * or never recorded when it was asked for. An unparseable stamp reads as null and
 * so waits forever, which is the safe direction: the deadline exists to interrupt
 * agents, and one armed off a timestamp nobody can read would do it immediately.
 */
function drainingForMs(intent: { state: string; requestedAt: string | null }, nowMs: number): number | null {
  if (intent.state !== 'draining' || !intent.requestedAt) return null;
  const since = Date.parse(intent.requestedAt);
  if (Number.isNaN(since)) return null;
  return Math.max(0, nowMs - since);
}

/** The standing before any reading has been taken, or after one could not be. */
function unknownStanding(at: string, reason = 'no update check has run yet'): BuildStanding {
  return {
    head: null,
    upstream: null,
    behind: 0,
    ahead: 0,
    commits: [],
    dirty: false,
    branch: null,
    checkedAt: at,
    unavailable: reason,
  };
}
