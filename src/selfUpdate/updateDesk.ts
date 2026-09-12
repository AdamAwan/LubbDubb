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

// → docs/spec/21-self-update.md

const SUPERVISOR_ENV = 'LUBBDUBB_SUPERVISOR';

export class UpdateDesk {
  private standing: BuildStanding | null = null;
  private project: BuildStanding | null = null;
  private checking: Promise<void> | null = null;
  private lastCheckedMs = 0;
  private snoozedUntilMs: Record<SnoozeTarget, number> = { upgrade: 0, projectPull: 0 };
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
      autoUpdate: boolean;
      drainDeadlineMs: number;
      projectAutoPull?: boolean;
      snoozeMs?: number;
      project?: { root: string; remote: string; branch: string };
      read?: typeof readBuildStanding;
      pull?: typeof pullFastForward;
      now?: () => string;
      supervised?: boolean;
    },
  ) {}

  private get now(): () => string {
    return this.deps.now ?? (() => new Date().toISOString());
  }

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

  private snoozeStamps(): SnoozeStamps {
    const nowMs = Date.now();
    const stamp = (untilMs: number): string | null => (untilMs > nowMs ? new Date(untilMs).toISOString() : null);
    return { upgrade: stamp(this.snoozedUntilMs.upgrade), projectPull: stamp(this.snoozedUntilMs.projectPull) };
  }

  async check(force: boolean): Promise<BuildStanding> {
    const dueAt = this.lastCheckedMs + this.deps.checkIntervalMs;
    if (!force && this.standing && Date.now() < dueAt) return this.standing;
    if (this.checking) {
      await this.checking;
      return this.standing ?? unknownStanding(this.now());
    }
    const read = this.deps.read ?? readBuildStanding;
    const project = this.deps.project;
    this.checking = Promise.all([
      read({ remote: this.deps.remote, branch: this.deps.branch, now: this.now }),
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

  private advanceDrain(): void {
    const intent = this.deps.store.upgrades.readUpgradeIntent();
    if (intent.state !== 'draining') return;
    if (this.deps.store.agents.countLiveAgents() > 0) return;
    this.deps.store.upgrades.writeUpgradeIntent({ ...intent, state: 'ready' });
  }

  private advanceAuto(): void {
    if (!this.deps.autoUpdate) return;
    for (let i = 0; i < 3; i++) {
      const intent = this.deps.store.upgrades.readUpgradeIntent();
      const step = autoUpgradeStep({
        intent,
        upgradable: upgradability(this.standing ?? unknownStanding(this.now())),
        live: this.deps.store.agents.countLiveAgents(),
        supervised: this.supervised,
        drainDeadlineMs: this.deps.drainDeadlineMs,
        drainingForMs: drainingForMs(intent, Date.parse(this.now())),
      });
      if (!step) return;
      const result = this.request(step.action, { interrupt: step.interrupt });
      if (!result.ok) return;
      console.log(`[lubbdubb] auto-update: ${step.action} — ${step.why}`);
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
    const intent = this.deps.store.upgrades.readUpgradeIntent();
    if (intent.state !== 'applying') return null;
    const paused = !intent.pausedByDrain;
    this.deps.runtimeControl.apply({ paused });
    return paused;
  }

  reading(): BuildReading {
    return buildReading({
      standing: this.standing ?? unknownStanding(this.now()),
      intent: this.deps.store.upgrades.readUpgradeIntent(),
      live: this.deps.store.agents.countLiveAgents(),
      supervised: this.supervised,
      project: this.project,
      projectBranch: this.deps.project?.branch,
      projectAutoPull: this.deps.projectAutoPull ?? false,
      snoozedUntil: this.snoozeStamps(),
    });
  }

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

  request(action: UpgradeAction, opts: { interrupt?: boolean } = {}): UpgradeTransition {
    const standing = this.standing ?? unknownStanding(this.now());
    const intent = this.deps.store.upgrades.readUpgradeIntent();
    const result = applyUpgradeAction(
      intent,
      { action, interrupt: opts.interrupt },
      {
        upgradable: upgradability(standing, this.project),
        live: this.deps.store.agents.countLiveAgents(),
        alreadyPaused: this.deps.runtimeControl.paused,
        targetSha: standing.upstream,
        now: this.now(),
      },
    );
    if (!result.ok) return result;

    if (action === 'cancel') {
      if (intent.pausedByDrain) this.deps.runtimeControl.apply({ paused: false });
    } else {
      this.deps.runtimeControl.apply({ paused: true });
    }
    this.deps.store.upgrades.writeUpgradeIntent(result.intent);

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
    if (this.deps.store.upgrades.readUpgradeIntent().state === 'idle') return;
    this.deps.store.upgrades.writeUpgradeIntent(IDLE_INTENT);
  }
}

function drainingForMs(intent: { state: string; requestedAt: string | null }, nowMs: number): number | null {
  if (intent.state !== 'draining' || !intent.requestedAt) return null;
  const since = Date.parse(intent.requestedAt);
  if (Number.isNaN(since)) return null;
  return Math.max(0, nowMs - since);
}

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
