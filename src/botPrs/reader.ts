import type { ErrorRecorder } from '../errorLog.js';
import type { SendResult } from '../sink/actionSink.js';
import type { BotPr, BotPrsReading, BotPullRequest } from '../types.js';
import { readDependencyUpdate } from './dependencyUpdate.js';

// → docs/spec/37-bot-prs.md#the-read

export interface BotPrSource {
  listBotPullRequests(authors: readonly RegExp[]): Promise<BotPullRequest[]>;
  claimBotPr(prNumber: number): Promise<SendResult>;
}

type ClaimOutcome = { ok: true } | { ok: false; status: 404 | 409 | 502; refusal: string };

interface BotPrReaderDeps {
  source: BotPrSource;
  authors: () => readonly string[];
  errors: ErrorRecorder;
  now?: () => number;
  maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 60_000;

export class BotPrReader {
  private last: { at: number; key: string; reading: BotPrsReading } | null = null;
  private inFlight: Promise<BotPrsReading> | null = null;

  constructor(private readonly deps: BotPrReaderDeps) {}

  async read(): Promise<BotPrsReading> {
    const sources = this.deps.authors();
    const patterns = compile(sources);
    if (patterns.length === 0) return { configured: false, readAt: null, pullRequests: [], error: null };
    const now = (this.deps.now ?? Date.now)();
    const key = sources.join('\n');
    const last = this.last;
    if (last !== null && last.key === key && now - last.at < (this.deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS))
      return last.reading;
    this.inFlight ??= this.fetch(patterns, key, now).finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  async claim(prNumber: number): Promise<ClaimOutcome> {
    const reading = await this.read();
    const pr = reading.pullRequests.find((p) => p.number === prNumber);
    if (pr === undefined) return { ok: false, status: 404, refusal: 'no open bot pull request with that number' };
    if (pr.viewerReviewing) return { ok: false, status: 409, refusal: 'you are already on this pull request' };
    try {
      const sent = await this.deps.source.claimBotPr(prNumber);
      if (!sent.ok)
        return { ok: false, status: 409, refusal: 'the provider could not say who you are, so nobody was added' };
    } catch (err) {
      const message = (err as Error).message;
      this.deps.errors.record({ source: 'provider', message: `Claiming bot PR ${prNumber} failed: ${message}` });
      return { ok: false, status: 502, refusal: message };
    }
    this.last = null;
    return { ok: true };
  }

  private async fetch(patterns: RegExp[], key: string, now: number): Promise<BotPrsReading> {
    try {
      const pulls = await this.deps.source.listBotPullRequests(patterns);
      const reading: BotPrsReading = {
        configured: true,
        readAt: new Date(now).toISOString(),
        pullRequests: pulls.map(toBotPr).sort((a, b) => a.number - b.number),
        error: null,
      };
      this.last = { at: now, key, reading };
      return reading;
    } catch (err) {
      const message = (err as Error).message;
      this.deps.errors.record({ source: 'provider', message: `Bot PR read failed: ${message}` });
      const stale = this.last?.key === key ? this.last.reading : null;
      return {
        configured: true,
        readAt: stale?.readAt ?? null,
        pullRequests: stale?.pullRequests ?? [],
        error: message,
      };
    }
  }
}

export function toBotPr(pr: BotPullRequest): BotPr {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.author,
    ciStatus: pr.ciStatus,
    reviewers: pr.reviewers,
    viewerReviewing: pr.viewerReviewing,
    url: pr.url ?? null,
    createdAt: pr.createdAt ?? null,
    headSha: pr.headSha || null,
    update: readDependencyUpdate(pr.title, pr.body),
  };
}

export function compile(sources: readonly string[]): RegExp[] {
  return sources.flatMap((source) => {
    try {
      return [new RegExp(source)];
    } catch {
      return [];
    }
  });
}
