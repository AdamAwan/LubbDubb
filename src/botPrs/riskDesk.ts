import type { ErrorRecorder } from '../errorLog.js';
import { nextCronRun } from '../schedules/cron.js';
import { nextRunAfter } from '../schedules/schedule.js';
import type { Store } from '../store/store.js';
import { isActiveTask } from '../tasks.js';
import type {
  AssessedBotPr,
  BotPr,
  BotPrDetail,
  BotPrRiskRun,
  BotPrRiskStanding,
  BotPrRiskTrigger,
  BotPullRequest,
} from '../types.js';
import { compile, toBotPr, type BotPrSource } from './reader.js';
import {
  releaseNotesInBody,
  releaseTags,
  riskBriefing,
  riskOrder,
  sourceRepoInBody,
  type BriefEntry,
} from './riskBrief.js';

// → docs/spec/37-bot-prs.md#the-risk-summary

export const RISK_BATCH_LIMIT = 20;

const ALREADY_OUT = 'a risk summary is already out; it takes the next batch when it ends';

interface BotPrRiskSource extends Pick<BotPrSource, 'listBotPullRequests'> {
  readBotPrDetail(prNumber: number): Promise<BotPrDetail>;
  readReleaseNotes(source: { owner: string; repo: string }, tags: readonly string[]): Promise<string | null>;
}

interface BotPrRiskDeskDeps {
  store: Store;
  source: BotPrRiskSource;
  authors: () => readonly string[];
  schedule: () => string;
  errors: ErrorRecorder;
}

type RiskRequestOutcome = { ok: true; run: BotPrRiskRun } | { ok: false; status: 409 | 422 | 502; refusal: string };

export class BotPrRiskDesk {
  private due: { cron: string; at: Date | null } | null = null;
  private assembling: Promise<RiskRequestOutcome> | null = null;

  constructor(private readonly deps: BotPrRiskDeskDeps) {}

  /**
   * @public called by the pulse, beside `schedules`. The assembly it starts is not awaited by the
   * pulse: it is a provider sweep, and the fleet must not wait on it.
   */
  run(now: Date = new Date()): Promise<RiskRequestOutcome> | null {
    this.settle();
    const cron = this.deps.schedule().trim();
    if (cron === '') return null;
    if (this.due?.cron !== cron) {
      this.due = { cron, at: nextCronRun(cron, now) };
      if (this.due.at === null)
        this.deps.errors.record({
          source: 'cycle',
          message: `botPrs.riskSchedule "${cron}" is not a cron expression that ever fires; no risk summary is scheduled`,
        });
    }
    if (this.due.at === null || now < this.due.at) return null;
    this.due = { cron, at: nextCronRun(cron, now) };
    return this.request('schedule');
  }

  request(trigger: BotPrRiskTrigger): Promise<RiskRequestOutcome> {
    this.assembling ??= this.assemble(trigger)
      .catch((err: unknown): RiskRequestOutcome => {
        const message = (err as Error).message;
        this.deps.errors.record({
          source: 'provider',
          message: `Assembling the bot PR risk summary failed: ${message}`,
        });
        return { ok: false, status: 502, refusal: message };
      })
      .finally(() => (this.assembling = null));
    return this.assembling;
  }

  standing(): BotPrRiskStanding {
    const cron = this.deps.schedule().trim();
    const run = this.deps.store.botPrRisks.lastRun();
    return {
      schedule: cron === '' ? null : cron,
      nextRunAt: cron === '' ? null : nextRunAfter(cron, new Date()),
      run:
        run === null
          ? null
          : {
              id: run.id,
              status: run.status,
              trigger: run.trigger,
              createdAt: run.createdAt,
              settledAt: run.settledAt,
              prs: run.subjects.length,
            },
    };
  }

  assessed(prs: readonly BotPr[]): AssessedBotPr[] {
    const numbers = prs.map((pr) => pr.number);
    const risks = this.deps.store.botPrRisks.risksFor(numbers);
    const outcomes = this.deps.store.botPrOutcomes.latestFor(numbers);
    return prs.map((pr) => ({
      ...pr,
      risk: risks.find((r) => r.prNumber === pr.number && r.headSha === pr.headSha) ?? null,
      outcome: outcomes.find((o) => o.prNumber === pr.number) ?? null,
    }));
  }

  private settle(): void {
    const { store } = this.deps;
    const open = store.botPrRisks.openRunNow();
    if (open?.status !== 'dispatched' || open.taskId === null) return;
    const task = store.tasks.getTask(open.taskId);
    if (task === null || !isActiveTask(task)) store.botPrRisks.settleRun(open.id);
  }

  private async assemble(trigger: BotPrRiskTrigger): Promise<RiskRequestOutcome> {
    const { store, source } = this.deps;
    this.settle();
    if (store.botPrRisks.openRunNow() !== null) return { ok: false, status: 409, refusal: ALREADY_OUT };
    const patterns = compile(this.deps.authors());
    if (patterns.length === 0)
      return { ok: false, status: 422, refusal: 'no bot is named in botPrs.authors, so there is nothing to read' };
    const pulls = new Map((await source.listBotPullRequests(patterns)).map((p) => [p.number, p]));
    const unseen = this.assessed([...pulls.values()].map(toBotPr))
      .filter((pr) => pr.update.kind !== 'unknown' && pr.headSha !== null && pr.risk === null)
      .sort(riskOrder)
      .slice(0, RISK_BATCH_LIMIT);
    if (unseen.length === 0)
      return { ok: false, status: 409, refusal: 'every classified bot pull request has already been read on its head' };
    const entries = await Promise.all(unseen.map((pr) => this.entry(pr, pulls.get(pr.number)!)));
    const run = store.botPrRisks.openRun({
      trigger,
      subjects: unseen.map((pr) => ({ number: pr.number, headSha: pr.headSha!, title: pr.title })),
      briefing: riskBriefing(entries),
    });
    return run === null ? { ok: false, status: 409, refusal: ALREADY_OUT } : { ok: true, run };
  }

  private async entry(pr: BotPr, pull: BotPullRequest): Promise<BriefEntry> {
    const detail = await this.deps.source.readBotPrDetail(pr.number);
    const body = detail.body ?? pull.body ?? null;
    const inBody = releaseNotesInBody(body);
    if (inBody !== null) return { pr, detail, notes: { text: inBody, from: 'pull request' } };
    const repo = sourceRepoInBody(body);
    const tags = releaseTags(pr.update.packageName, pr.update.to);
    const released = repo === null || tags.length === 0 ? null : await this.releaseNotes(repo, tags);
    return { pr, detail, notes: released === null ? null : { text: released, from: 'release' } };
  }

  private async releaseNotes(repo: { owner: string; repo: string }, tags: string[]): Promise<string | null> {
    try {
      return await this.deps.source.readReleaseNotes(repo, tags);
    } catch (err) {
      this.deps.errors.record({
        source: 'provider',
        message: `Reading ${repo.owner}/${repo.repo}'s release notes failed: ${(err as Error).message}`,
      });
      return null;
    }
  }
}
