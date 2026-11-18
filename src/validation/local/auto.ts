import type { ErrorRecorder } from '../../errorLog.js';
import { goalMergedAt, landedCommits } from '../../environments/landings.js';
import { issueOriginRef } from '../../issueOrigins.js';
import type { LocalRunChoices } from '../../localRun/ref.js';
import type { LocalRunner } from '../../localRun/runner.js';
import { prState } from '../../pr/prHealth.js';
import type { Store } from '../../store/store.js';
import type { GoalLanding, LocalRun, LocalValidation, WorldSnapshot } from '../../types.js';
import { localValidationIsOpen } from './stale.js';

// → docs/spec/32-local-validation.md#the-automatic-press

interface Candidate {
  originRef: string;
  at?: string;
  commit: string;
  readyAt: number;
}

const SINCE_KEY = 'localValidation.autoSince';

const READ: ReadonlySet<LocalValidation['status']> = new Set(['passed', 'failed', 'skipped']);

interface LocalValidationAutoPressDeps {
  store: Store;
  on: () => boolean;
  configured: () => boolean;
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
    if (this.pressing !== null) return;
    const since = this.since();
    if (since === null || !this.deps.configured()) return;
    try {
      if (!this.free()) return;
      for (const candidate of this.candidates(world, since)) {
        if (candidate.at !== undefined && (await this.tipOf(candidate.at)) !== candidate.commit) continue;
        if (!this.free()) return;
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
      const started = await this.deps.start(candidate.originRef, candidate.at);
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

  private since(): number | null {
    const stored = this.deps.store.world.getConnectorState(SINCE_KEY) ?? '';
    if (!this.deps.on()) {
      if (stored !== '') this.deps.store.world.setConnectorState(SINCE_KEY, '');
      return null;
    }
    if (stored !== '') return Date.parse(stored);
    const now = new Date();
    this.deps.store.world.setConnectorState(SINCE_KEY, now.toISOString());
    return now.getTime();
  }

  private tipOf(ref: string): Promise<string | null> {
    return this.deps.tipOf(ref).catch((err: unknown) => {
      this.deps.errors.record({
        source: 'cycle',
        message: `Could not read the local tip of ${ref} for an automatic validation: ${(err as Error).message}`,
      });
      return null;
    });
  }

  private failed(err: unknown): void {
    this.deps.errors.record({
      source: 'cycle',
      message: `The automatic local validation press failed: ${(err as Error).message}`,
    });
  }

  private free(): boolean {
    const live = this.deps.store.localRuns.liveLocalRun();
    if (live === null) return true;
    if (live.status === 'stopping') return false;
    const latest = this.deps.store.localValidations.latestLocalValidation(live.originRef);
    return (
      latest !== null && latest.runId === live.id && latest.requestedBy === 'auto' && !localValidationIsOpen(latest)
    );
  }

  private candidates(world: WorldSnapshot, since: number): Candidate[] {
    const latest = new Map(this.deps.store.localValidations.listLatestLocalValidations().map((v) => [v.originRef, v]));
    const found = [...this.delivered(world, latest), ...this.landed(world, since, latest)];
    return found.filter((c) => !this.refused.has(key(c.originRef, c.commit))).sort((a, b) => a.readyAt - b.readyAt);
  }

  private delivered(world: WorldSnapshot, latest: ReadonlyMap<string, LocalValidation>): Candidate[] {
    const deliveries = new Map(this.deps.store.verdicts.listDeliveries().map((d) => [d.originRef, d]));
    const prs = new Map(world.pullRequests.filter((p) => prState(p) === 'open').map((p) => [p.branch, p]));
    const found: Candidate[] = [];
    for (const issue of world.issues) {
      if (issue.state !== 'open') continue;
      const originRef = issueOriginRef('root', issue.number);
      const delivery = deliveries.get(originRef);
      if (delivery === undefined) continue;
      const last = latest.get(originRef);
      if (last !== undefined && localValidationIsOpen(last)) continue;
      const at = this.deps.choicesFor(originRef).target;
      const pr = at === null ? undefined : prs.get(at);
      if (at === null || pr?.ciStatus !== 'passing' || !pr.headSha || last?.commit === pr.headSha) continue;
      found.push({ originRef, at, commit: pr.headSha, readyAt: Date.parse(delivery.decidedAt) });
    }
    return found;
  }

  private landed(world: WorldSnapshot, since: number, latest: ReadonlyMap<string, LocalValidation>): Candidate[] {
    const landings = this.deps.store.environments.listGoalLandings();
    const found: Candidate[] = [];
    for (const issue of world.issues) {
      const originRef = issueOriginRef('root', issue.number);
      const mergedAt = goalMergedAt(landings, originRef);
      if (mergedAt === null || mergedAt < since) continue;
      const last = latest.get(originRef);
      if (last !== undefined && (localValidationIsOpen(last) || READ.has(last.status))) continue;
      if (last !== undefined && Date.parse(last.requestedAt) >= mergedAt) continue;
      if (this.deps.choicesFor(originRef).target !== null) continue;
      found.push({ originRef, commit: lastCommit(landings, originRef), readyAt: mergedAt });
    }
    return found;
  }
}

function lastCommit(landings: readonly GoalLanding[], goalRef: string): string {
  return landedCommits(landings, goalRef).at(-1) ?? goalRef;
}

function key(originRef: string, commit: string): string {
  return `${originRef}@${commit}`;
}
