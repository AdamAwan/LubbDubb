import type { CiStatus, PrPerson } from './world.js';

/** An open pull request raised by an author `botPrs.authors` names. → docs/spec/37-bot-prs.md */
export interface BotPullRequest {
  number: number;
  title: string;
  author: string;
  ciStatus: CiStatus;
  /** Azure's optional, individually named reviewers; GitHub's assignees. Who has taken it on. */
  reviewers: PrPerson[];
  viewerReviewing: boolean;
  url?: string;
  createdAt?: string;
  body?: string;
  headSha?: string;
}

/** One file a bot's pull request changes. `patch` is null where the provider reports paths only. */
export interface BotPrFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  patch: string | null;
}

/** `body` null: the listing's body was already whole. `files` null: the provider cannot list them. */
export interface BotPrDetail {
  body: string | null;
  files: BotPrFile[] | null;
}

export type UpdateKind = 'major' | 'minor' | 'patch' | 'unknown';

export interface DependencyUpdate {
  kind: UpdateKind;
  packageName: string | null;
  from: string | null;
  to: string | null;
}

export interface BotPr {
  number: number;
  title: string;
  author: string;
  ciStatus: CiStatus;
  reviewers: PrPerson[];
  viewerReviewing: boolean;
  url: string | null;
  createdAt: string | null;
  headSha: string | null;
  update: DependencyUpdate;
}

/** `configured` false is `botPrs.authors` naming no usable pattern; `error` keeps the last good rows. */
export interface BotPrsReading {
  configured: boolean;
  readAt: string | null;
  pullRequests: BotPr[];
  error: string | null;
}

export type BotPrRiskLevel = 'low' | 'medium' | 'high';

/** → docs/spec/37-bot-prs.md#the-risk-summary */
export interface BotPrRisk {
  prNumber: number;
  headSha: string;
  risk: BotPrRiskLevel;
  summary: string;
  runId: string;
  assessedAt: string;
}

export interface BotPrRiskSubject {
  number: number;
  headSha: string;
  title: string;
}

export type BotPrRiskRunStatus = 'pending' | 'dispatched' | 'done';

export type BotPrRiskTrigger = 'schedule' | 'operator';

export interface BotPrRiskRun {
  id: string;
  status: BotPrRiskRunStatus;
  trigger: BotPrRiskTrigger;
  subjects: BotPrRiskSubject[];
  taskId: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** A run waiting for its agent carries what that agent is to be shown, assembled when it opened. */
export interface PendingBotPrRiskRun extends BotPrRiskRun {
  briefing: string;
}

/** Where the risk summary stands: the schedule, when it next fires, and the latest run. */
export interface BotPrRiskStanding {
  schedule: string | null;
  nextRunAt: string | null;
  run: (Pick<BotPrRiskRun, 'id' | 'status' | 'trigger' | 'createdAt' | 'settledAt'> & { prs: number }) | null;
}

/** What a CI-fix agent on a watched bot pull request found the failure to be. → docs/spec/37-bot-prs.md#when-ci-fails-on-one */
export type BotPrOutcomeKind = 'adapted' | 'upstream-bug' | 'intended-break' | 'unclear';

export interface BotPrOutcome {
  prNumber: number;
  /** The head the world held when it was recorded; empty where the provider did not report one. */
  headSha: string;
  outcome: BotPrOutcomeKind;
  summary: string;
  upstreamUrl: string | null;
  fixedIn: string | null;
  recordedAt: string;
}

/** `risk` is the verdict on this head only: a push to the pull request leaves it null until re-read. */
export interface AssessedBotPr extends BotPr {
  risk: BotPrRisk | null;
  /** The latest outcome on this pull request, on whatever head it was recorded. */
  outcome: BotPrOutcome | null;
}
