import type { ReviewAreaRule } from '../config/config.js';
import { prGoalIndex } from '../graph/prGoals.js';
import { buildLessonInsights, lessonInsightsSince, type LessonInsights } from '../insights/lessonInsights.js';
import { isReturnOrigin } from '../insights/remedyInsights.js';
import type { Store } from '../store/store.js';
import type { LessonDraft } from '../types.js';
import { lessonExcludedPrs } from './lessonDesk.js';

// → docs/spec/41-repo-lessons.md#did-it-work

interface LessonReadingContext {
  reviewAreas: readonly ReviewAreaRule[];
  lessonLabel: string;
  now: number;
}

/** The did-it-work reading over this store's drafts: one fold, read by the Causes tab and the pool digest alike. */
export function readLessonInsights(
  store: Store,
  drafts: readonly LessonDraft[],
  context: LessonReadingContext,
): LessonInsights {
  const since = lessonInsightsSince(drafts);
  return buildLessonInsights({
    drafts,
    remedies: since === null ? [] : store.remedies.listRemediesSince(since),
    threadLabels: since === null ? [] : store.prThreadLabels.listThreadLabelsSince(since),
    goalOfPr: since === null ? new Map() : prGoalIndex(store.graph.listWorkNodes()),
    excludedPrs: lessonExcludedPrs(store.world.getWorldBaseline(), drafts, context.lessonLabel),
    reviewAreas: context.reviewAreas,
    returnDispatches:
      since === null
        ? []
        : store.tasks
            .listTasks()
            .flatMap((t) =>
              t.createdAt >= since && isReturnOrigin(t.originRef)
                ? [{ originRef: t.originRef ?? '', createdAt: t.createdAt }]
                : [],
            ),
    now: context.now,
  });
}
