import type {
  DiscussionEntry,
  DiscussionSubjectKind,
  FeatureSequence,
  FeatureSummary,
  GoalPause,
  GoalPriority,
  GoalReachStatus,
  IssueState,
} from '../types.js';

export type FeatureChildStanding = 'delivered' | 'inFlight' | 'queued' | 'fellShort' | 'settled' | 'unwatched';

export interface FeatureChildRow {
  number: number;
  title: string;
  issueType: string | null;
  standing: FeatureChildStanding;
  outcome: string | null;
  workItemState: string | null;
  costUsd: number | null;
  changedAt: string;
}

export interface FeatureCounts {
  delivered: number;
  inFlight: number;
  queued: number;
  fellShort: number;
  settled: number;
  unwatched: number;
  total: number;
}

export interface FeatureReach {
  environment: string;
  status: GoalReachStatus;
  goals: number;
  total: number;
}

export interface FeatureWorkingRow {
  number: number;
  title: string;
  since: string;
}

export interface FeatureReportRow {
  number: number;
  title: string;
  summary: string;
  by: string;
  at: string;
}

type FeatureBlockKind = 'question' | 'fellShort';

export interface FeatureBlockRow {
  number: number;
  title: string;
  kind: FeatureBlockKind;
  summary: string;
  since: string;
}

export interface FeatureBriefing {
  working: FeatureWorkingRow[];
  workingTotal: number;
  delivered: FeatureReportRow[];
  deliveredTotal: number;
  blocking: FeatureBlockRow[];
  blockingTotal: number;
}

export interface FeatureRollup {
  number: number;
  title: string;
  slot: number;
  /** Null when the Feature itself is not mirrored. */
  state: IssueState | null;
  workItemState: string | null;
  issueType: string | null;
  counts: FeatureCounts;
  briefing: FeatureBriefing;
  children: FeatureChildRow[];
  costUsd: number | null;
  reach: FeatureReach[];
  summary: FeatureSummary | null;
  sequence: FeatureSequence | null;
  lastLandingAt: string | null;
  landings: FeatureLandingRow[];
  standingKey: string;
  /** The summary was refiled unchanged until rule `feature-summary` stopped re-dispatching. → docs/spec/05-dispatcher.md */
  summaryHeld: boolean;
  paused: GoalPause | null;
  priority: GoalPriority | null;
}

export interface FeatureLandingRow {
  goal: number;
  prNumber: number;
  at: string;
}

/** A story's feature, or a feature's story, as its own Discussion tab gathers it. → docs/spec/40-discussions.md#in-the-cockpit */
export interface DiscussionNeighbour {
  number: number;
  title: string | null;
  kind: DiscussionSubjectKind;
  path: string;
  obsidianUrl: string | null;
  standingDecisions: DiscussionEntry[];
  openQuestions: DiscussionEntry[];
}

/** `GET /api/discussions/:number`. → docs/spec/40-discussions.md#in-the-cockpit */
export interface DiscussionReading {
  /** False where `discussionsDir` is unset — the tab says how to turn it on. */
  enabled: boolean;
  number: number;
  kind: DiscussionSubjectKind | null;
  title: string | null;
  /** The file, or null where none has been written yet. */
  path: string | null;
  /** `obsidian://open?path=…` where the file sits inside a vault, else null. */
  obsidianUrl: string | null;
  entries: DiscussionEntry[];
  related: DiscussionNeighbour[];
}

export interface FeatureBoardPayload {
  features: FeatureRollup[];
  orphans: Omit<
    FeatureRollup,
    | 'number'
    | 'title'
    | 'slot'
    | 'state'
    | 'workItemState'
    | 'issueType'
    | 'reach'
    | 'summary'
    | 'sequence'
    | 'standingKey'
    | 'summaryHeld'
    | 'paused'
    | 'priority'
  > | null;
  unresolved: number;
  environments: string[];
  backfilling: boolean;
  refUrls: Record<string, string>;
}
