import type { ReviewAreaRule } from '../config/config.js';
import { lessonGroups, LESSON_WINDOW_MS } from '../lessons/groups.js';
import { CAUSE_COPY } from '../remedies/remedies.js';
import type {
  LessonDraftStatus,
  LessonFix,
  LessonPeriod,
  PrThreadLabel,
  Remedy,
  RemedyCause,
  RemedyKind,
  LessonDraft,
} from '../types.js';

// → docs/spec/41-repo-lessons.md#did-it-work

type LessonVerdict = 'working' | 'not-working' | 'too-early';

export interface LessonRow {
  id: string;
  groupKey: string;
  kind: RemedyKind;
  cause: RemedyCause;
  causeLabel: string;
  where: string;
  status: LessonDraftStatus;
  fix: LessonFix | null;
  title: string | null;
  goals: number;
  prRef: string | null;
  ticketRef: string | null;
  createdAt: string;
  /** For an adopted lesson, when the desk saw its pull request merge; null otherwise. */
  mergedAt: string | null;
  before: LessonPeriod | null;
  /** Null until 30 days have passed since the merge. */
  after: LessonPeriod | null;
  verdict: LessonVerdict | null;
}

export interface LessonInsights {
  drafts: LessonRow[];
  adopted: number;
  working: number;
  notWorking: number;
  tooEarly: number;
}

/** A return dispatch as the reading counts it: the pull request it went back to, which kind of return, and when. */
export interface ReturnDispatch {
  prNumber: number;
  kind: RemedyKind;
  createdAt: string;
}

interface LessonInsightInput {
  drafts: readonly LessonDraft[];
  remedies: readonly Remedy[];
  threadLabels: readonly PrThreadLabel[];
  goalOfPr: ReadonlyMap<number, string>;
  excludedPrs: ReadonlySet<number>;
  reviewAreas: readonly ReviewAreaRule[];
  returnDispatches: readonly ReturnDispatch[];
  now: number;
}

export function buildLessonInsights(input: LessonInsightInput): LessonInsights {
  const drafts = [...input.drafts].reverse().map((d) => row(d, input));
  const adopted = drafts.filter((d) => d.status === 'adopted');
  return {
    drafts,
    adopted: adopted.length,
    working: adopted.filter((d) => d.verdict === 'working').length,
    notWorking: adopted.filter((d) => d.verdict === 'not-working').length,
    tooEarly: adopted.filter((d) => d.verdict === 'too-early').length,
  };
}

/** The earliest instant the reading needs remedies and thread labels from; null with nothing adopted. */
export function lessonInsightsSince(drafts: readonly LessonDraft[]): string | null {
  let earliest: number | null = null;
  for (const d of drafts) {
    if (d.status !== 'adopted' || d.settledAt === null) continue;
    const start = Date.parse(d.settledAt) - LESSON_WINDOW_MS;
    if (earliest === null || start < earliest) earliest = start;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

function row(d: LessonDraft, input: LessonInsightInput): LessonRow {
  const base = {
    id: d.id,
    groupKey: d.groupKey,
    kind: d.kind,
    cause: d.cause,
    causeLabel: CAUSE_COPY[d.cause].label,
    where: d.where,
    status: d.status,
    fix: d.fix,
    title: d.title,
    goals: d.goals.length,
    prRef: d.prNumber === null ? null : `pr:${d.prNumber}`,
    ticketRef: d.ticketRef,
    createdAt: d.createdAt,
  };
  if (d.status !== 'adopted' || d.settledAt === null)
    return { ...base, mergedAt: null, before: null, after: null, verdict: null };
  const merged = Date.parse(d.settledAt);
  const before = period(d, input, merged - LESSON_WINDOW_MS, merged);
  const after = input.now >= merged + LESSON_WINDOW_MS ? period(d, input, merged, merged + LESSON_WINDOW_MS) : null;
  return { ...base, mergedAt: d.settledAt, before, after, verdict: verdict(before, after) };
}

function period(d: LessonDraft, input: LessonInsightInput, start: number, end: number): LessonPeriod {
  const since = new Date(start).toISOString();
  const until = new Date(end).toISOString();
  const group = lessonGroups({
    remedies: input.remedies.filter(
      (r) => r.kind === d.kind && r.cause === d.cause && r.createdAt >= since && r.createdAt < until,
    ),
    threadLabels: input.threadLabels,
    goalOfPr: input.goalOfPr,
    excludedPrs: input.excludedPrs,
    reviewAreas: input.reviewAreas,
    since,
  }).find((g) => g.key === d.groupKey);
  const misses = group?.goals.length ?? 0;
  const returns = input.returnDispatches.filter(
    (t) => t.kind === d.kind && t.createdAt >= since && t.createdAt < until && !input.excludedPrs.has(t.prNumber),
  ).length;
  return { misses, returns };
}

/** Misses per same-kind return dispatch; null when nothing missed and nothing came back, unbounded for a miss with no return to divide by. */
export function missRate(period: LessonPeriod): number | null {
  if (period.returns > 0) return period.misses / period.returns;
  return period.misses > 0 ? Number.POSITIVE_INFINITY : null;
}

function verdict(before: LessonPeriod, after: LessonPeriod | null): LessonVerdict {
  if (after === null) return 'too-early';
  if (after.misses === 0) return 'working';
  return (missRate(after) ?? 0) < (missRate(before) ?? 0) ? 'working' : 'not-working';
}
