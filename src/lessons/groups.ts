import type { ReviewAreaRule } from '../config/config.js';
import { goalOf } from '../graph/prGoals.js';
import { DAY_MS } from '../primitives.js';
import type {
  LessonDraft,
  LessonDraftStatus,
  LessonPullRequest,
  PrThreadLabel,
  Remedy,
  RemedyCause,
  RemedyGuard,
  RemedyKind,
  RetroMiss,
} from '../types.js';
import { areasForPath } from '../review/areas.js';
import { lessonPrsForGroup } from './lessonOrigin.js';
import { RETRO_MISS_KIND } from '../retro/retro.js';

// → docs/spec/41-repo-lessons.md#noticing-a-repeat-miss

export const LESSON_WINDOW_MS = 30 * DAY_MS;

const EXCLUDED_CAUSES: ReadonlySet<RemedyCause> = new Set(['other', 'defect', 'flake', 'environment', 'inherited']);

const LESSON_GUARDS: ReadonlySet<RemedyGuard> = new Set(['documented', 'undocumented']);

const LIVE: ReadonlySet<LessonDraftStatus> = new Set(['pending', 'dispatched', 'pr-open']);
const FINAL: ReadonlySet<LessonDraftStatus> = new Set(['adopted', 'filed']);

/** The part of a past draft the fold reads: what it was about, where it ended, and the goals it spanned. */
export type PriorDraft = Pick<LessonDraft, 'groupKey' | 'status' | 'goals' | 'settledAt'>;

export interface LessonGroupInputs {
  remedies: readonly Remedy[];
  /** What retrospectives recorded as missed, each placed by its file like a review remedy's thread. */
  retroMisses: readonly RetroMiss[];
  threadLabels: readonly PrThreadLabel[];
  /** `prGoalIndex` over the work graph. */
  goalOfPr: ReadonlyMap<number, string>;
  /** Bot-authored pull requests and lesson pull requests: what is learnt on them is not about the fleet's work. */
  excludedPrs: ReadonlySet<number>;
  /** Goals whose retrospective misses are not about the fleet's work: a lesson ticket the fleet took on. */
  excludedGoals: ReadonlySet<string>;
  reviewAreas: readonly ReviewAreaRule[];
  /** The window's start; a remedy filed before it is not counted. */
  since: string;
}

interface LessonGroup {
  key: string;
  kind: RemedyKind;
  cause: RemedyCause;
  where: string;
  goals: string[];
  remedyIds: string[];
  retroMissIds: string[];
  /** Every account in the group, whichever source it came from. */
  misses: Miss[];
}

interface Miss {
  source: 'remedy' | 'retro';
  id: string;
  goal: string;
  createdAt: string;
}

export function lessonGroupKey(kind: RemedyKind, cause: RemedyCause, where: string): string {
  return `${kind}/${cause}/${where}`;
}

/** Every group the window's remedies and retrospective misses form, whatever its size. */
export function lessonGroups(input: LessonGroupInputs): LessonGroup[] {
  const groups = new Map<string, LessonGroup>();
  const add = (kind: RemedyKind, cause: RemedyCause, where: string, miss: Miss) => {
    const key = lessonGroupKey(kind, cause, where);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, kind, cause, where, goals: [], remedyIds: [], retroMissIds: [], misses: [] };
      groups.set(key, group);
    }
    group.misses.push(miss);
  };
  const threadsByTask = changedThreadsByTask(input.threadLabels);
  for (const remedy of input.remedies) {
    if (!counts(remedy, input)) continue;
    const miss: Miss = {
      source: 'remedy',
      id: remedy.id,
      goal: goalOf(input.goalOfPr, remedy.prNumber),
      createdAt: remedy.createdAt,
    };
    for (const where of wheresOf(remedy, threadsByTask, input.reviewAreas)) add(remedy.kind, remedy.cause, where, miss);
  }
  const leftOutGoals = goalsLeftOut(input);
  for (const retro of input.retroMisses) {
    if (!retroCounts(retro, input, leftOutGoals)) continue;
    const miss: Miss = { source: 'retro', id: retro.id, goal: retro.originRef, createdAt: retro.createdAt };
    for (const where of pathWheres(retro.path, input.reviewAreas)) add(RETRO_MISS_KIND, retro.cause, where, miss);
  }
  return [...groups.values()].map(fill);
}

/**
 * The groups a lesson may be drafted for now: at least `minGoals` distinct goals, no draft live or
 * final for the group, and — after a settled draft — enough new goals since it settled. The caller
 * has already turned lessons off below 2.
 */
export function lessonCandidates(
  input: LessonGroupInputs,
  drafts: readonly PriorDraft[],
  minGoals: number,
  others: readonly LessonPullRequest[] = [],
): LessonGroup[] {
  const out: LessonGroup[] = [];
  for (const group of lessonGroups(input)) {
    if (group.goals.length < minGoals) continue;
    const own = [...drafts.filter((d) => d.groupKey === group.key), ...othersAsDrafts(group.key, others)];
    if (own.some((d) => LIVE.has(d.status) || FINAL.has(d.status))) continue;
    const last = latestSettled(own);
    if (last !== null && goalsSince(group, last.settledAt) < Math.max(last.goals.length, minGoals)) continue;
    out.push(group);
  }
  return out.sort((a, b) => b.goals.length - a.goals.length || a.key.localeCompare(b.key));
}

/** Another fleet's lesson pull request for the group, read as a draft of this fleet's: open holds it, merged ends it, closed is a no. */
function othersAsDrafts(groupKey: string, others: readonly LessonPullRequest[]): PriorDraft[] {
  return lessonPrsForGroup(others, groupKey).map((pr) => ({
    groupKey,
    status: pr.state === 'open' ? 'pr-open' : pr.state === 'merged' ? 'adopted' : 'declined',
    goals: [],
    settledAt: pr.closedAt,
  }));
}

function counts(remedy: Remedy, input: LessonGroupInputs): boolean {
  return (
    remedy.createdAt >= input.since &&
    LESSON_GUARDS.has(remedy.guard) &&
    !EXCLUDED_CAUSES.has(remedy.cause) &&
    !input.excludedPrs.has(remedy.prNumber)
  );
}

/** A retrospective miss counts as a review remedy would, and not on a goal behind a left-out pull request or a lesson ticket. */
function retroCounts(miss: RetroMiss, input: LessonGroupInputs, leftOutGoals: ReadonlySet<string>): boolean {
  return (
    miss.createdAt >= input.since &&
    LESSON_GUARDS.has(miss.guard) &&
    !EXCLUDED_CAUSES.has(miss.cause) &&
    !leftOutGoals.has(miss.originRef)
  );
}

/** The goals whose retrospectives are not about the fleet's work: the lesson tickets, and every goal behind a left-out pull request. */
export function goalsLeftOut(
  input: Pick<LessonGroupInputs, 'excludedGoals' | 'excludedPrs' | 'goalOfPr'>,
): Set<string> {
  const out = new Set(input.excludedGoals);
  for (const pr of input.excludedPrs) out.add(goalOf(input.goalOfPr, pr));
  return out;
}

function changedThreadsByTask(labels: readonly PrThreadLabel[]): Map<string, PrThreadLabel[]> {
  const out = new Map<string, PrThreadLabel[]>();
  for (const label of labels) {
    if (!label.changedCode || label.path === null) continue;
    const held = out.get(label.taskId) ?? [];
    held.push(label);
    out.set(label.taskId, held);
  }
  return out;
}

function wheresOf(
  remedy: Remedy,
  threadsByTask: ReadonlyMap<string, PrThreadLabel[]>,
  rules: readonly ReviewAreaRule[],
): string[] {
  if (remedy.kind === 'ci') return [...new Set(remedy.checks)];
  const wheres = new Set<string>();
  for (const thread of threadsByTask.get(remedy.taskId) ?? []) {
    if (thread.prNumber !== remedy.prNumber || thread.path === null) continue;
    for (const where of pathWheres(thread.path, rules)) wheres.add(where);
  }
  return [...wheres];
}

/** The review areas a path falls in, or its first two directories where no area rule matches. */
function pathWheres(path: string, rules: readonly ReviewAreaRule[]): string[] {
  const areas = areasForPath(path, rules) ?? [];
  return areas.length > 0 ? areas : [leadingDirectories(path)];
}

/** The first two directories of a repository-relative path; `.` for a file at the root. */
function leadingDirectories(path: string): string {
  const dirs = path
    .split('/')
    .filter((s) => s !== '')
    .slice(0, -1);
  return dirs.length === 0 ? '.' : dirs.slice(0, 2).join('/');
}

function fill(group: LessonGroup): LessonGroup {
  const goals = new Set<string>();
  for (const miss of group.misses) {
    goals.add(miss.goal);
    (miss.source === 'remedy' ? group.remedyIds : group.retroMissIds).push(miss.id);
  }
  group.goals = [...goals].sort();
  return group;
}

function latestSettled(drafts: readonly PriorDraft[]): (PriorDraft & { settledAt: string }) | null {
  let last: (PriorDraft & { settledAt: string }) | null = null;
  for (const d of drafts) {
    if (d.settledAt === null) continue;
    if (last === null || d.settledAt > last.settledAt) last = { ...d, settledAt: d.settledAt };
  }
  return last;
}

function goalsSince(group: LessonGroup, settledAt: string): number {
  return new Set(group.misses.filter((m) => m.createdAt > settledAt).map((m) => m.goal)).size;
}
