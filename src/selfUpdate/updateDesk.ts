import type { ErrorRecorder } from '../errorLog.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { Store } from '../store/store.js';
import { readBuildStanding, type BuildStanding } from './buildStanding.js';
import {
  applyUpgradeAction,
  buildReading,
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
      /** Injectable so a test can stand in a checkout it controls, or none at all. */
      read?: typeof readBuildStanding;
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
    this.checking = read({ remote: this.deps.remote, branch: this.deps.branch, now: this.now })
      .then((standing) => {
        this.standing = standing;
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

  /** What the gauge and the panel read. Serves the last reading; takes none. */
  reading(): BuildReading {
    return buildReading({
      standing: this.standing ?? unknownStanding(this.now()),
      intent: this.deps.store.readUpgradeIntent(),
      live: this.deps.store.countLiveAgents(),
      supervised: this.supervised,
    });
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
        upgradable: upgradability(standing),
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
