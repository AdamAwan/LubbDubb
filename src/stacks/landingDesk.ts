import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { PullRequest, StackLanding } from '../types.js';
import { settleLandings } from './landing.js';

/** The world a settle pass is judged against — the pulse's own snapshot. */
interface SettleWorld {
  pullRequests: PullRequest[];
  closedPullRequests?: PullRequest[];
}

/**
 * Where a standing stack-landing intent is recorded, ended, and reconciled with
 * the world — the {@link ProposalDesk} of this feature, and small for the same
 * reason.
 *
 * It is deliberately *not* where a merge happens. The executor asks this record
 * whether a rung's merge is authorized and then runs it through the one path an
 * accepted proposal takes; nothing here touches the sink, and nothing here loops
 * over rungs. See `landing.ts` for why a loop would be wrong.
 */
export class StackLandingDesk {
  constructor(
    private readonly store: Store,
    private readonly escalations: EscalationInbox,
    private readonly errors: ErrorRecorder,
  ) {}

  /** Record the operator's authorization over a chain, scoped to these rungs. */
  land(ref: string, rungs: number[]): StackLanding {
    return this.store.recordStackLanding(ref, rungs);
  }

  /**
   * Call it off. Keyed on a rung rather than the intent's id for the reason
   * everything else here is: the operator clicks `stop` on a chain whose ref may
   * have changed under them since they clicked `land`.
   */
  revoke(prNumber: number): StackLanding | null {
    const standing = this.store.standingLandingForPr(prNumber);
    if (!standing) return null;
    return this.store.settleStackLanding(standing.id, 'revoked', 'you called it off');
  }

  /**
   * Stop the intent that authorized this PR's merge, because the merge failed.
   *
   * Without this arm the failed merge would be re-proposed once its settle window
   * lapsed, auto-accepted again by the same standing intent, and retried forever
   * behind an escalation nobody asked for. A merge that will not go through is a
   * red rung by another name.
   */
  stopForFailedMerge(prNumber: number, message: string): void {
    const standing = this.store.standingLandingForPr(prNumber);
    if (!standing) return;
    this.stop(standing, `merging #${prNumber} failed: ${message}`);
  }

  /**
   * Reconcile every standing intent with the world, once per pulse.
   *
   * A failure here is recorded rather than thrown: the intent is an authorization
   * the operator gave, and dropping the whole cycle because one could not be
   * settled would cost far more than the settle is worth. The next pulse retries.
   */
  settle(world: SettleWorld): void {
    try {
      // `mergedPrs` is read here rather than taken from the pulse: the world's
      // `closedPullRequests` forgets a merge after `closedPrWindowMs`, and an
      // intent routinely outlives that. Without it a chain that took longer than
      // the window to land stops itself, with an escalation saying nothing
      // observed a rung merging — about a rung this harness merged. A graph one
      // pulse stale is not a gap: a rung merged *this* pulse is still in the
      // world's own lists, which is what the arms below read.
      const merged = this.store.mergedPrs();
      for (const settlement of settleLandings(this.store.listStandingLandings(), { ...world, merged })) {
        if (settlement.status === 'landed') {
          this.store.settleStackLanding(settlement.landing.id, 'landed', null);
          continue;
        }
        this.stop(settlement.landing, settlement.reason ?? 'a rung is no longer ready');
      }
    } catch (err) {
      this.errors.record({
        source: 'cycle',
        message: `Settling stack landings failed: ${(err as Error).message}`,
        detail: (err as Error).stack ?? null,
      });
    }
  }

  /**
   * End an intent adversely, and **say so**.
   *
   * The escalation is not decoration. A chain that drops below two rungs stops
   * being a stack, so its head line — and with it the rack's "stopped" chip —
   * leaves the Parts Inspection panel entirely. The inbox item is what makes the
   * stop impossible to miss whatever the rack is showing. Raised only when the
   * store's compare-and-set actually won, so a settle racing a revoke asks the
   * operator once or not at all.
   */
  private stop(landing: StackLanding, reason: string): void {
    const stopped = this.store.settleStackLanding(landing.id, 'stopped', reason);
    if (!stopped) return;
    this.escalations.create({
      type: 'approve_change',
      prompt:
        `You authorized landing ${landing.ref} (${landing.rungs.length} pull requests) and it has stopped: ${reason}. ` +
        `Nothing further will merge on its own. Fix the rung and click "land the stack" again once you have read what changed.`,
      context: { stackRef: landing.ref, rungs: landing.rungs, stackLandingStopped: true },
    });
  }
}
