// → docs/spec/41-repo-lessons.md#the-outcome

/** The kinds of fix a lesson can be: the one list the tool, the type and the pool reader all read. */
export const LESSON_FIXES = ['code', 'guard', 'contradiction', 'note'] as const;

/** What each fix is, in words: the tool's description of `fix` and a lesson's body both read it. */
export const FIX_COPY: Record<(typeof LESSON_FIXES)[number], string> = {
  code: 'the cause removed in the code',
  guard: 'a lint rule, type or test that fails when the miss is made',
  contradiction: 'code and docs disagreed, and one was corrected',
  note: 'a line in the nearest CLAUDE.md or document',
};
