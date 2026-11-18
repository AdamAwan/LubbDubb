import type { ErrorRecorder } from '../../errorLog.js';
import { issueOriginRef } from '../../issueOrigins.js';
import type { LocalRunChoices } from '../../localRun/ref.js';
import type { LocalRunner } from '../../localRun/runner.js';
import { prState } from '../../pr/prHealth.js';
import type { Store } from '../../store/store.js';
import type { LocalRun, LocalValidation, WorldSnapshot } from '../../types.js';
import { localValidationIsOpen } from './stale.js';

// → docs/spec/32-local-validation.md#the-automatic-press

interface Candidate {
  originRef: string;
  ref: string;
  commit: string;
  deliveredAt: string;
}

interface LocalValidationAutoPressDeps {
  store: Store;
  enabled: () => boolean;
  start: LocalRunner['start'];
  request: (input: { originRef: string; run: LocalRun; requestedBy: 'auto' }) => LocalValidation;
  tipOf: (ref: string) => Promise<string>;
  choicesFor: (originRef: string) => LocalRunChoices;
  cycle: () => void;
  errors: ErrorRecorder;
}

export class LocalValidationAutoPress {
  private readonly refused = new Set<string>();
  private pressing: Promise<void> | null = null;

  constructor(private readonly deps: LocalValidationAutoPressDeps) {}

  settled(): Promise<void> {
    return this.pressing ?? Promise.resolve();
  }

  async run(world: WorldSnapshot): Promise<void> {
    if (!this.deps.enabled() || this.pressing !== null) return;
    try {
      const live = this.deps.store.localRuns.liveLocalRun();
      if (live !== null && !this.ours(live)) return;
      for (const candidate of this.candidates(world)) {
        const tip = await this.deps.tipOf(candidate.ref).catch((err: unknown) => {
          this.deps.errors.record({
            source: 'cycle',
            message: `Could not read the local tip of ${candidate.ref} for an automatic validation: ${(err as Error).message}`,
          });
          return null;
        });
        if (tip !== candidate.commit) continue;
        const now = this.deps.store.localRuns.liveLocalRun();
        if (now !== null && !this.ours(now)) return;
        this.pressing = this.press(candidate).finally(() => {
          this.pressing = null;
        });
        return;
      }
    } catch (err) {
      this.failed(err);
    }
  }

  private async press(candidate: Candidate): Promise<void> {
    try {
      const started = await this.deps.start(candidate.originRef, candidate.ref);
      if (!started.ok) {
        this.refused.add(key(candidate.originRef, candidate.commit));
        this.deps.errors.record({
          source: 'cycle',
          message: `Could not bring ${candidate.originRef} up to validate it automatically: ${started.error}`,
        });
        return;
      }
      this.deps.request({ originRef: candidate.originRef, run: started.run, requestedBy: 'auto' });
      this.deps.cycle();
    } catch (err) {
      this.failed(err);
    }
  }

  private failed(err: unknown): void {
    this.deps.errors.record({
      source: 'cycle',
      message: `The automatic local validation press failed: ${(err as Error).message}`,
    });
  }

  private ours(live: LocalRun): boolean {
    if (live.status === 'stopping') return false;
    const latest = this.deps.store.localValidations.latestLocalValidation(live.originRef);
    return (
      latest !== null && latest.runId === live.id && latest.requestedBy === 'auto' && !localValidationIsOpen(latest)
    );
  }

  private candidates(world: WorldSnapshot): Candidate[] {
    const deliveries = new Map(this.deps.store.verdicts.listDeliveries().map((d) => [d.originRef, d]));
    const latest = new Map(this.deps.store.localValidations.listLatestLocalValidations().map((v) => [v.originRef, v]));
    const prs = new Map(world.pullRequests.filter((p) => prState(p) === 'open').map((p) => [p.branch, p]));
    const found: Candidate[] = [];
    for (const issue of world.issues) {
      if (issue.state !== 'open') continue;
      const originRef = issueOriginRef('root', issue.number);
      const delivery = deliveries.get(originRef);
      if (delivery === undefined) continue;
      const last = latest.get(originRef);
      if (last !== undefined && localValidationIsOpen(last)) continue;
      const ref = this.deps.choicesFor(originRef).target;
      const pr = ref === null ? undefined : prs.get(ref);
      if (ref === null || pr?.ciStatus !== 'passing' || !pr.headSha) continue;
      if (last?.commit === pr.headSha || this.refused.has(key(originRef, pr.headSha))) continue;
      found.push({ originRef, ref, commit: pr.headSha, deliveredAt: delivery.decidedAt });
    }
    return found.sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt));
  }
}

function key(originRef: string, commit: string): string {
  return `${originRef}@${commit}`;
}
