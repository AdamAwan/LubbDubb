// → docs/spec/41-repo-lessons.md#configuration

export interface LessonPolicy {
  /** Distinct goals a group must span inside the window before a lesson is drafted; 0 turns lessons off. */
  minGoals: number;
  /** The Azure DevOps work item every lesson's own Task is filed under; null files none. */
  parentWorkItem: number | null;
}

export const DEFAULT_LESSONS: LessonPolicy = {
  minGoals: 2,
  parentWorkItem: null,
};
