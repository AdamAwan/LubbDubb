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
  at: string | null;
  commit: string;
  readyAt: string;
}

const SINCE_KEY = 'localValidation.autoSince';

const UNDISPATCHED_AFTER_MS = 15 * 60 * 1000;

const READ: ReadonlySet<LocalValidation['status']> = new Set(['passed', 'failed', 'skipped']);

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
    const since = this.since();
    if (since === null || this.pressing !== null) return;
    try {
      const live = this.deps.store.localRuns.liveLocalRun();
      if (live !== null) this.unstick(live);
      if (live !== null && !this.ours(live)) return;
      for (const candidate of this.candidates(world, since)) {
        if (candidate.at !== null && (await this.tipOf(candidate.at)) !== candidate.commit) continue;
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
      const started = await this.deps.start(candidate.originRef, candidate.at ?? undefined);
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

  private since(): string | null {
    const stored = this.deps.store.world.getConnectorState(SINCE_KEY) ?? '';
    if (!this.deps.enabled()) {
      if (stored !== '') this.deps.store.world.setConnectorState(SINCE_KEY, '');
      return null;
    }
    if (stored !== '') return stored;
    const now = new Date().toISOString();
    this.deps.store.world.setConnectorState(SINCE_KEY, now);
    return now;
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

  private unstick(live: LocalRun): void {
    const latest = this.deps.store.localValidations.latestLocalValidation(live.originRef);
    if (latest?.status !== 'pending' || latest.requestedBy !== 'auto' || latest.runId !== live.id) return;
    if (Date.now() - Date.parse(latest.requestedAt) < UNDISPATCHED_AFTER_MS) return;
    this.deps.store.localValidations.abandonLocalValidation(
      latest.id,
      'started automatically, and never dispatched — the goal is not one the fleet will work on now',
    );
  }

  private ours(live: LocalRun): boolean {
    if (live.status === 'stopping') return false;
    const latest = this.deps.store.localValidations.latestLocalValidation(live.originRef);
    return (
      latest !== null && latest.runId === live.id && latest.requestedBy === 'auto' && !localValidationIsOpen(latest)
    );
  }

  private candidates(world: WorldSnapshot, since: string): Candidate[] {
    const latest = new Map(this.deps.store.localValidations.listLatestLocalValidations().map((v) => [v.originRef, v]));
    const found = [...this.delivered(world, latest), ...this.landed(since, latest)];
    return found
      .filter((c) => !this.refused.has(key(c.originRef, c.commit)))
      .sort((a, b) => Date.parse(a.readyAt) - Date.parse(b.readyAt));
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
      found.push({ originRef, at, commit: pr.headSha, readyAt: delivery.decidedAt });
    }
    return found;
  }

  private landed(since: string, latest: ReadonlyMap<string, LocalValidation>): Candidate[] {
    const newest = new Map<string, { sha: string; at: string }>();
    for (const landing of this.deps.store.environments.listGoalLandings()) {
      if (landing.onIntegration !== true) continue;
      const at = landing.mergedAt ?? landing.recordedAt;
      const seen = newest.get(landing.goalRef);
      if (seen === undefined || Date.parse(at) > Date.parse(seen.at))
        newest.set(landing.goalRef, { sha: landing.sha, at });
    }
    const found: Candidate[] = [];
    for (const [originRef, landing] of newest) {
      if (Date.parse(landing.at) < Date.parse(since)) continue;
      const last = latest.get(originRef);
      if (last !== undefined && (localValidationIsOpen(last) || READ.has(last.status))) continue;
      if (last !== undefined && Date.parse(last.requestedAt) >= Date.parse(landing.at)) continue;
      if (this.deps.choicesFor(originRef).target !== null) continue;
      found.push({ originRef, at: null, commit: landing.sha, readyAt: landing.at });
    }
    return found;
  }
}

function key(originRef: string, commit: string): string {
  return `${originRef}@${commit}`;
}
