import type { LESSON_FIXES } from '../lessons/fixes.js';
import type { RemedyCause, RemedyGuard, RemedyKind } from './remedies.js';
import type { PrState } from './world.js';

// → docs/spec/41-repo-lessons.md#the-record-and-the-desk

export type LessonDraftStatus =
  'pending' | 'dispatched' | 'pr-open' | 'adopted' | 'declined' | 'filed' | 'nothing' | 'unanswered';

export type LessonOutcome = 'pull_request' | 'ticket' | 'nothing';

export type LessonFix = (typeof LESSON_FIXES)[number];

/** One remedy a draft was made on, as the evidence cites it. */
export interface LessonMiss {
  remedyId: string;
  prNumber: number;
  goal: string;
  guard: RemedyGuard;
  summary: string;
}

/** The life of one draft: never what the lesson says, which lives in the repository. */
export interface LessonDraft {
  id: string;
  groupKey: string;
  kind: RemedyKind;
  cause: RemedyCause;
  where: string;
  /** Distinct goals the draft was made on; their count is the bar a redraft must clear again. */
  goals: string[];
  misses: LessonMiss[];
  status: LessonDraftStatus;
  taskId: string | null;
  fix: LessonFix | null;
  title: string | null;
  summary: string | null;
  reason: string | null;
  prNumber: number | null;
  ticketRef: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** The one draft waiting for its agent, with the briefing it is dispatched with. */
export interface PendingLessonDraft extends LessonDraft {
  briefing: string;
}

/** One side of an adopted lesson's merge: the group's misses in distinct goals, and the same-kind return dispatches. */
export interface LessonPeriod {
  misses: number;
  returns: number;
}

/** A pull request on a `lesson/` branch, whoever opened it and whatever it is labelled: how fleets see each other's lessons. */
export interface LessonPullRequest {
  number: number;
  branch: string;
  url: string;
  state: PrState;
  closedAt: string | null;
}
