import type { ReviewAreaRule } from '../config/config.js';
import type { LessonDraftStatus, PrThreadLabel, Remedy, RemedyCause, RemedyGuard, RemedyKind } from '../types.js';
import { areasForPath } from '../review/areas.js';

// → docs/spec/41-repo-lessons.md#noticing-a-repeat-miss

export const LESSON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const EXCLUDED_CAUSES: ReadonlySet<RemedyCause> = new Set(['other', 'defect', 'flake', 'environment', 'inherited']);

const LESSON_GUARDS: ReadonlySet<RemedyGuard> = new Set(['documented', 'undocumented']);

const LIVE: ReadonlySet<LessonDraftStatus> = new Set(['pending', 'dispatched', 'pr-open']);
const FINAL: ReadonlySet<LessonDraftStatus> = new Set(['adopted', 'filed']);

/** The part of a past draft the fold reads: what it was about, where it ended, and how many goals it spanned. */
export interface PriorDraft {
  groupKey: string;
  status: LessonDraftStatus;
  missCount: number;
  settledAt: string | null;
}

export interface LessonGroupInputs {
  remedies: readonly Remedy[];
  threadLabels: readonly PrThreadLabel[];
  /** `prGoalIndex` over the work graph. */
  goalOfPr: ReadonlyMap<number, string>;
  /** Bot-authored pull requests and lesson pull requests: what is learnt on them is not about the fleet's work. */
  excludedPrs: ReadonlySet<number>;
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
  prNumbers: number[];
  remedyIds: string[];
  guards: Record<'documented' | 'undocumented', number>;
}

interface LessonCandidate extends LessonGroup {
  /** The settled draft this one redrafts, or null for a group drafted for the first time. */
  redrafts: PriorDraft | null;
}

interface Miss {
  remedy: Remedy;
  goal: string;
}

export function lessonGroupKey(kind: RemedyKind, cause: RemedyCause, where: string): string {
  return `${kind}/${cause}/${where}`;
}

/** Every group the window's remedies form, whatever its size. */
export function lessonGroups(input: LessonGroupInputs): LessonGroup[] {
  const groups = new Map<string, { group: LessonGroup; misses: Miss[] }>();
  const threadsByTask = changedThreadsByTask(input.threadLabels);
  for (const remedy of input.remedies) {
    if (!counts(remedy, input)) continue;
    const goal = input.goalOfPr.get(remedy.prNumber) ?? `pr:${remedy.prNumber}`;
    for (const where of wheresOf(remedy, threadsByTask, input.reviewAreas)) {
      const key = lessonGroupKey(remedy.kind, remedy.cause, where);
      let held = groups.get(key);
      if (held === undefined) {
        held = {
          group: {
            key,
            kind: remedy.kind,
            cause: remedy.cause,
            where,
            goals: [],
            prNumbers: [],
            remedyIds: [],
            guards: { documented: 0, undocumented: 0 },
          },
          misses: [],
        };
        groups.set(key, held);
      }
      held.misses.push({ remedy, goal });
    }
  }
  return [...groups.values()].map(({ group, misses }) => fill(group, misses));
}

/**
 * The groups a lesson may be drafted for now: at least `minGoals` distinct goals, no draft live or
 * final for the group, and — after a settled draft — enough new goals since it settled.
 */
export function lessonCandidates(
  input: LessonGroupInputs,
  drafts: readonly PriorDraft[],
  minGoals: number,
): LessonCandidate[] {
  if (minGoals < 2) return [];
  const out: LessonCandidate[] = [];
  for (const group of lessonGroups(input)) {
    if (group.goals.length < minGoals) continue;
    const own = drafts.filter((d) => d.groupKey === group.key);
    if (own.some((d) => LIVE.has(d.status) || FINAL.has(d.status))) continue;
    const last = latestSettled(own);
    if (last !== null && goalsSince(group, input, last.settledAt) < Math.max(last.missCount, minGoals)) continue;
    out.push({ ...group, redrafts: last });
  }
  return out.sort((a, b) => b.goals.length - a.goals.length || a.key.localeCompare(b.key));
}

function counts(remedy: Remedy, input: LessonGroupInputs): boolean {
  return (
    remedy.createdAt >= input.since &&
    LESSON_GUARDS.has(remedy.guard) &&
    !EXCLUDED_CAUSES.has(remedy.cause) &&
    !input.excludedPrs.has(remedy.prNumber)
  );
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
    if (thread.prNumber !== remedy.prNumber) continue;
    for (const where of reviewWheres(thread.path)) wheres.add(where);
  }
  return [...wheres];

  function reviewWheres(path: string | null): string[] {
    const areas = areasForPath(path, rules) ?? [];
    return areas.length > 0 ? areas : [leadingDirectories(path ?? '')];
  }
}

/** The first two directories of a repository-relative path; `.` for a file at the root. */
function leadingDirectories(path: string): string {
  const dirs = path
    .split('/')
    .filter((s) => s !== '')
    .slice(0, -1);
  return dirs.length === 0 ? '.' : dirs.slice(0, 2).join('/');
}

function fill(group: LessonGroup, misses: Miss[]): LessonGroup {
  const goals = new Set<string>();
  const prs = new Set<number>();
  for (const { remedy, goal } of misses) {
    goals.add(goal);
    prs.add(remedy.prNumber);
    group.remedyIds.push(remedy.id);
    if (remedy.guard === 'documented' || remedy.guard === 'undocumented') group.guards[remedy.guard] += 1;
  }
  group.goals = [...goals].sort();
  group.prNumbers = [...prs].sort((a, b) => a - b);
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

function goalsSince(group: LessonGroup, input: LessonGroupInputs, settledAt: string): number {
  const after = new Set<string>();
  const ids = new Set(group.remedyIds);
  for (const remedy of input.remedies) {
    if (!ids.has(remedy.id) || remedy.createdAt <= settledAt) continue;
    after.add(input.goalOfPr.get(remedy.prNumber) ?? `pr:${remedy.prNumber}`);
  }
  return after.size;
}
