import type { ReviewAreaRule } from '../config/config.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import { prGoalIndex } from '../graph/prGoals.js';
import type { Store } from '../store/store.js';
import { isActiveTask } from '../tasks.js';
import type { LessonDraft, PullRequest, WorldSnapshot } from '../types.js';
import { lessonBriefing, lessonMisses } from './evidence.js';
import { prState } from '../pr/prHealth.js';
import { lessonCandidates, LESSON_WINDOW_MS, type LessonGroupInputs } from './groups.js';
import { isLessonBranch, lessonMarker, lessonWorkItemNumber } from './lessonOrigin.js';
import { othersLessonPrs, type LessonPrReading } from './lessonPrs.js';

// → docs/spec/41-repo-lessons.md#the-record-and-the-desk

/** Each open lesson pull request is watched, and its CI and review rounds are fleet work nobody has asked for yet. */
const MAX_OPEN_LESSON_PRS = 2;

interface LessonDeskDeps {
  store: Store;
  /** `lessons.minGoals`; 0 opens nothing. */
  minGoals: number;
  reviewAreas: readonly ReviewAreaRule[];
  lessonLabel: string;
  /** Every fleet's lesson pull requests. */
  lessonPrs: LessonPrReading;
  /** Closes a lesson pull request's own Task when the pull request settles; absent closes nothing. */
  sink?: ActionSink;
  errors?: ErrorRecorder;
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
    if (this.deps.minGoals < 2) {
      const pending = this.deps.store.lessons.pendingDraft();
      if (pending) this.deps.store.lessons.settle(pending.id, 'unanswered', ['pending']);
      return;
    }
    this.open(world);
  }

  private settle(): void {
    const { store } = this.deps;
    for (const draft of store.lessons.unsettledDrafts()) {
      if (draft.status === 'dispatched' && !taskStillRuns(store, draft))
        store.lessons.settle(draft.id, 'unanswered', ['dispatched']);
      if (draft.status !== 'pr-open' || draft.prNumber === null) continue;
      const settled = store.graph.getWorkNode(`pr:${String(draft.prNumber)}`)?.status;
      if (settled === 'merged' && store.lessons.settle(draft.id, 'adopted', ['pr-open']))
        void this.closeTask(draft, 'completed');
      else if (settled === 'closed' && store.lessons.settle(draft.id, 'declined', ['pr-open']))
        void this.closeTask(draft, 'not_planned');
    }
  }

  /** The lesson's own Task follows its pull request, so the parent's children read which lessons were adopted. */
  private async closeTask(draft: LessonDraft, reason: 'completed' | 'not_planned'): Promise<void> {
    const { sink, errors } = this.deps;
    const number = draft.ticketRef === null ? null : lessonWorkItemNumber(draft.ticketRef);
    if (sink === undefined || number === null || !sink.canCloseIssue()) return;
    try {
      await sink.closeIssue({ number, reason });
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `closing lesson work item #${String(number)} (${reason}) failed: ${(err as Error).message}`,
      });
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
    if (lessonCandidates(input, drafts, this.deps.minGoals).length === 0) return;
    const read = this.deps.lessonPrs.held();
    if (read === null) return;
    const open = world.pullRequests.filter((pr) => prState(pr) === 'open');
    const candidate = lessonCandidates(input, drafts, this.deps.minGoals, othersLessonPrs(read, drafts)).find(
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
    pr.botAuthored === true || isLessonBranch(pr.branch) || (pr.labels ?? []).includes(lessonLabel);
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
