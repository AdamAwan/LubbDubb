import type { ReviewAreaRule } from '../config/config.js';
import { prGoalIndex } from '../graph/prGoals.js';
import type { Store } from '../store/store.js';
import { isActiveTask } from '../tasks.js';
import type { LessonDraft, PullRequest, WorldSnapshot } from '../types.js';
import { lessonBriefing, lessonMisses } from './evidence.js';
import { lessonCandidates, LESSON_WINDOW_MS, type LessonGroupInputs, type PriorDraft } from './groups.js';
import { lessonMarker } from './lessonOrigin.js';

// → docs/spec/41-repo-lessons.md#the-record-and-the-desk

/** Each open lesson pull request is watched, and its CI and review rounds are fleet work nobody has asked for yet. */
const MAX_OPEN_LESSON_PRS = 2;

interface LessonDeskDeps {
  store: Store;
  /** `lessons.minGoals`; 0 opens nothing. */
  minGoals: number;
  reviewAreas: readonly ReviewAreaRule[];
  lessonLabel: string;
  now?: () => number;
}

/** Settles drafts and opens the next one; reads no world of its own and never waits on anything. */
export class LessonDesk {
  private readonly now: () => number;

  constructor(private readonly deps: LessonDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** @public called by the pulse, beside `appErrorTriage`. */
  run(world: WorldSnapshot): void {
    this.settle();
    if (this.deps.minGoals < 2) return;
    this.open(world);
  }

  private settle(): void {
    const { store } = this.deps;
    const merged = store.graph.settledPrs();
    for (const draft of store.lessons.listDrafts()) {
      if (draft.status === 'dispatched' && !taskStillRuns(store, draft))
        store.lessons.settle(draft.id, 'unanswered', ['dispatched']);
      if (draft.status !== 'pr-open' || draft.prNumber === null) continue;
      const settled = merged.get(draft.prNumber);
      if (settled === 'merged') store.lessons.settle(draft.id, 'adopted', ['pr-open']);
      else if (settled === 'closed') store.lessons.settle(draft.id, 'declined', ['pr-open']);
    }
  }

  private open(world: WorldSnapshot): void {
    const { store } = this.deps;
    const drafts = store.lessons.listDrafts();
    if (drafts.some((d) => d.status === 'pending' || d.status === 'dispatched')) return;
    if (drafts.filter((d) => d.status === 'pr-open').length >= MAX_OPEN_LESSON_PRS) return;
    const since = new Date(this.now() - LESSON_WINDOW_MS).toISOString();
    const remedies = store.remedies.listRemediesSince(since);
    const goalOfPr = prGoalIndex(store.graph.listWorkNodes());
    const input: LessonGroupInputs = {
      remedies,
      threadLabels: store.prThreadLabels.listThreadLabelsSince(since),
      goalOfPr,
      excludedPrs: lessonExcludedPrs(world, drafts, this.deps.lessonLabel),
      reviewAreas: this.deps.reviewAreas,
      since,
    };
    const open = world.pullRequests.filter((pr) => pr.state === undefined || pr.state === 'open');
    const candidate = lessonCandidates(input, drafts.map(priorDraft), this.deps.minGoals).find(
      (c) => !open.some((pr) => pr.body?.includes(lessonMarker(c.key)) === true),
    );
    if (candidate === undefined) return;
    const misses = lessonMisses(candidate.remedyIds, remedies, goalOfPr);
    store.lessons.openDraft({
      groupKey: candidate.key,
      kind: candidate.kind,
      cause: candidate.cause,
      where: candidate.where,
      goals: candidate.goals,
      misses,
      briefing: lessonBriefing(candidate, misses, (goal) => store.scratch.getRetrospective(goal)?.summary ?? null),
    });
  }
}

/** Bot-authored pull requests, and lesson pull requests by label, branch or record. */
export function lessonExcludedPrs(
  world: Pick<WorldSnapshot, 'pullRequests' | 'closedPullRequests'> | null,
  drafts: readonly LessonDraft[],
  lessonLabel: string,
): Set<number> {
  const out = new Set<number>();
  const leftOut = (pr: PullRequest) =>
    pr.botAuthored === true || pr.branch.startsWith('lesson/') || (pr.labels ?? []).includes(lessonLabel);
  for (const pr of [...(world?.pullRequests ?? []), ...(world?.closedPullRequests ?? [])])
    if (leftOut(pr)) out.add(pr.number);
  for (const d of drafts) if (d.prNumber !== null) out.add(d.prNumber);
  return out;
}

function taskStillRuns(store: Store, draft: LessonDraft): boolean {
  if (draft.taskId === null) return true;
  const task = store.tasks.getTask(draft.taskId);
  return task !== null && isActiveTask(task);
}

function priorDraft(d: LessonDraft): PriorDraft {
  return { groupKey: d.groupKey, status: d.status, missCount: d.missCount, settledAt: d.settledAt };
}
