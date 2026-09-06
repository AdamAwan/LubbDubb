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
  type SnoozeStamps,
  type SnoozeTarget,
  type UpgradeAction,
  type UpgradeTransition,
} from './upgradePlan.js';

/** The environment variable `scripts/serve.ts` sets to announce itself. */
const SUPERVISOR_ENV = 'LUBBDUBB_SUPERVISOR';

/**
 * Where the harness watches its own build, and where a deliberate upgrade is driven from. →
 * `docs/spec/21-self-update.md` **The reading is in memory; the intent is in the store**:
 * the standing is a cheap fact about the world that must not be trusted across a restart,
 * the intent is an operator's decision that has to outlive the process. This decides no
 * dispatch — it pauses one, writes a row and, when asked, hands off.
 */
export class UpdateDesk {
  private standing: BuildStanding | null = null;
  private project: BuildStanding | null = null;
  private checking: Promise<void> | null = null;
  private lastCheckedMs = 0;
  /**
   * When each update ask stops being hidden, as epoch millis; zero for one that is not
   * snoozed.
   */
  private snoozedUntilMs: Record<SnoozeTarget, number> = { upgrade: 0, projectPull: 0 };
  /** Set while an auto-pull is in flight, so a slow pull cannot be started twice. */
  private pulling: Promise<unknown> | null = null;

  /**
   * How this process is asked to go down for an upgrade. Set by `src/server/main.ts`,
   * which owns shutdown; unset elsewhere, and then an `apply` records the intent and
   * stops there.
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
      /** How long an automatic drain waits before it interrupts what is left. */
      drainDeadlineMs: number;
      /**
       * Whether the *worked* checkout is fast-forwarded without being asked —
       * `selfUpdate.projectAutoPull`. Unlike `autoUpdate` this interrupts nothing and
       * restarts nothing, which is why it defaults the other way.
       */
      projectAutoPull?: boolean;
      /** How long a snooze hides an ask on the rail. */
      snoozeMs?: number;
      /**
       * The *worked* repository, read on this same timer — `config.repoRoot` against its
       * own remote and `defaultBranch`. Absent, the project reading is null and nothing
       * about the build changes.
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
   * drain to `ready`. **Never throws.** A check already in flight is joined rather
   * than restarted, and a failed check lands on the standing as `unavailable`
   * rather than in the fault log — an air-gapped deployment is not a fault.
   *
   * @public called by `Harness.runCycle`, beside the other bookkeeping passes.
   */
  async run(): Promise<void> {
    await this.check(false);
    this.advanceDrain();
    this.advanceAuto();
    this.advanceProjectPull();
  }

  /** `selfUpdate.projectAutoPull`: fast-forward the worked checkout, unasked. */
  private advanceProjectPull(): void {
    if (!this.deps.projectAutoPull) return;
    if (this.pulling) return;
    const target = this.deps.project;
    if (!target) return;
    if (!projectPullability(this.project, target.branch).can) return;
    this.pulling = this.pullProject()
      .then((result) => {
        if (result.ok) return;
        this.deps.errors.record({
          source: 'cycle',
          message: `Project auto-pull failed: ${result.error}`,
          detail: null,
        });
      })
      .finally(() => {
        this.pulling = null;
      });
  }

  /**
   * Hide one of the two update asks for `selfUpdate.snoozeMs`. The clock is the
   * whole of it: a snooze records no build, so the ask returns on whatever is
   * waiting by then rather than on the commit it was pressed on.
   *
   * @public called by the snooze route, which is the only way in.
   */
  snooze(target: SnoozeTarget): SnoozeStamps {
    this.snoozedUntilMs[target] = Date.now() + (this.deps.snoozeMs ?? 0);
    return this.snoozeStamps();
  }

  /** The two clocks as the wire carries them: an ISO stamp each, or null when clear. */
  private snoozeStamps(): SnoozeStamps {
    const nowMs = Date.now();
    const stamp = (untilMs: number): string | null => (untilMs > nowMs ? new Date(untilMs).toISOString() : null);
    return { upgrade: stamp(this.snoozedUntilMs.upgrade), projectPull: stamp(this.snoozedUntilMs.projectPull) };
  }

  /** Take a reading, unless one was taken recently and `force` is not set. */
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
      // Not `Promise.all`-fatal: a project reading's failure is a null beside the
      // build's answer rather than a check that took neither.
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
        // The reader returns `unavailable` rather than throwing, so arriving here
        // means it broke rather than the network did — worth a fault.
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
   * A drain that has run dry becomes a handoff that is safe to take — deliberately not the
   * handoff itself, which stays the operator's second decision.
   */
  private advanceDrain(): void {
    const intent = this.deps.store.readUpgradeIntent();
    if (intent.state !== 'draining') return;
    if (this.deps.store.countLiveAgents() > 0) return;
    this.deps.store.writeUpgradeIntent({ ...intent, state: 'ready' });
  }

  /** `selfUpdate.autoUpdate`: the two clicks, taken on the fleet's behalf. */
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
   * Carry the operator's own pause across the upgrade's restart, off the durable
   * `pausedByDrain`. `RuntimeControl` is not persisted, so a boot would otherwise
   * seed `paused` from `config.startPaused` — right for a cold boot, and silently
   * wrong here in both directions. Fenced on `applying`: any other state means this
   * restart was not the upgrade's. Returns what the fleet comes back as, or null.
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

  /** What the gauge and the panel read. */
  reading(): BuildReading {
    return buildReading({
      standing: this.standing ?? unknownStanding(this.now()),
      intent: this.deps.store.readUpgradeIntent(),
      live: this.deps.store.countLiveAgents(),
      supervised: this.supervised,
      project: this.project,
      projectBranch: this.deps.project?.branch,
      projectAutoPull: this.deps.projectAutoPull ?? false,
      snoozedUntil: this.snoozeStamps(),
    });
  }

  /**
   * Fast-forward the project checkout onto its remote branch — the project config layer is
   * read from `repoRoot`, so a stale clone is a harness on a policy the team has already
   * changed. **Nothing here reloads the config**: `main.ts`'s watcher picks the change up
   * on its own poll.
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

  /** Apply an operator's request. */
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
      // Only the pause this drain put on; the operator's own outlives the cancel.
      if (intent.pausedByDrain) this.deps.runtimeControl.apply({ paused: false });
    } else {
      this.deps.runtimeControl.apply({ paused: true });
    }
    this.deps.store.writeUpgradeIntent(result.intent);

    // The handoff is last, and only once the row says `applying`: the marker must be
    // durable before the process can go, or the next boot finds interrupted agents
    // and no record that anyone meant it.
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
 * How long the drain in this intent has been waiting, or null when it is not one or
 * recorded no stamp.
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
