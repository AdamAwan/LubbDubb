// → docs/spec/41-repo-lessons.md#configuration

export interface LessonPolicy {
  /** Distinct goals a group must span inside the window before a lesson is drafted; 0 turns lessons off. */
  minGoals: number;
}

export const DEFAULT_LESSONS: LessonPolicy = {
  minGoals: 2,
};
