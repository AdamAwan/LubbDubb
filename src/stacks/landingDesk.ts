import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { PullRequest, StackLanding } from '../types.js';
import { settleLandings } from './landing.js';

// → docs/spec/07-pull-requests.md

interface SettleWorld {
  pullRequests: PullRequest[];
  closedPullRequests?: PullRequest[];
  staleSources?: string[];
}

export class StackLandingDesk {
  constructor(
    private readonly store: Store,
    private readonly escalations: EscalationInbox,
    private readonly errors: ErrorRecorder,
  ) {}

  land(ref: string, rungs: number[]): StackLanding {
    return this.store.recordStackLanding(ref, rungs);
  }

  revoke(prNumber: number): StackLanding | null {
    const standing = this.store.standingLandingForPr(prNumber);
    if (!standing) return null;
    return this.store.settleStackLanding(standing.id, 'revoked', 'you called it off');
  }

  stopForFailedMerge(prNumber: number, message: string): void {
    const standing = this.store.standingLandingForPr(prNumber);
    if (!standing) return;
    this.stop(standing, `merging #${prNumber} failed: ${message}`);
  }

  settle(world: SettleWorld): void {
    try {
      if ((world.staleSources ?? []).length > 0) return;
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
