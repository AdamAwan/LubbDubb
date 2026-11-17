import type { ReviewAreaRule } from '../config/config.js';
import { prGoalIndex } from '../graph/prGoals.js';
import {
  buildLessonInsights,
  lessonInsightsSince,
  type LessonInsights,
  type ReturnDispatch,
} from '../insights/lessonInsights.js';
import { remedyOrigin } from '../remedies/remedies.js';
import type { Store } from '../store/store.js';
import type { LessonDraft } from '../types.js';
import { lessonExcludedPrs } from './lessonDesk.js';

// → docs/spec/41-repo-lessons.md#did-it-work

/** What the reading needs beyond the store: how review paths fold into areas, and what a lesson pull request is labelled. */
export interface LessonReadingContext {
  reviewAreas: readonly ReviewAreaRule[];
  lessonLabel: string;
}

/**
 * The did-it-work reading over `only` (every draft by default): one fold, read by the Causes tab and
 * the pool digest alike. Every draft's pull request is left out of the counts, whichever are read.
 */
export function readLessonInsights(
  store: Store,
  context: LessonReadingContext & { now: number },
  only?: readonly LessonDraft[],
): LessonInsights {
  const all = store.lessons.listDrafts();
  const drafts = only ?? all;
  const since = lessonInsightsSince(drafts);
  if (since === null)
    return buildLessonInsights({
      drafts,
      remedies: [],
      threadLabels: [],
      goalOfPr: new Map(),
      excludedPrs: new Set(),
      reviewAreas: context.reviewAreas,
      returnDispatches: [],
      now: context.now,
    });
  return buildLessonInsights({
    drafts,
    remedies: store.remedies.listRemediesSince(since),
    threadLabels: store.prThreadLabels.listThreadLabelsSince(since),
    goalOfPr: prGoalIndex(store.graph.listWorkNodes()),
    excludedPrs: lessonExcludedPrs(store.world.getWorldBaseline(), all, context.lessonLabel),
    reviewAreas: context.reviewAreas,
    returnDispatches: returnDispatchesSince(store, since),
    now: context.now,
  });
}

function returnDispatchesSince(store: Store, since: string): ReturnDispatch[] {
  return store.tasks.listTasks().flatMap((t) => {
    if (t.createdAt < since) return [];
    const origin = remedyOrigin(t.originRef);
    return origin.ok ? [{ prNumber: origin.prNumber, kind: origin.kind, createdAt: t.createdAt }] : [];
  });
}
