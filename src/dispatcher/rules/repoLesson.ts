import { lessonBranch, lessonDraftOrigin } from '../../lessons/lessonOrigin.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/41-repo-lessons.md#drafting-a-lesson

export function repoLesson(s: StageContext): void {
  const draft = s.lessonDraft;
  if (draft === null) return;
  const origin = lessonDraftOrigin(draft.id);
  if (s.activeOrigins.has(origin)) return;
  const branch = lessonBranch(draft.id);
  const title = `Draft a repo lesson for ${draft.groupKey}`;
  const reason =
    `The fleet came back to pull requests on ${String(draft.goals.length)} goals for the same reason — ` +
    `${draft.cause} in ${draft.where} — and nothing in the repository stopped it.`;
  s.candidates.push({
    origin,
    rule: 'repo-lesson',
    title,
    kind: 'code',
    branch,
    reason,
    action: {
      type: 'dispatch_code_agent',
      branch,
      base: s.defaultBranch,
      title,
      prompt:
        s.templates.render('repo-lesson', { cause: draft.cause, where: draft.where, goals: draft.goals.length }) +
        draft.briefing,
      lessonDraft: { id: draft.id },
      originRef: origin,
      originTitle: title,
      originSummary: null,
      rule: 'repo-lesson',
      reason,
    } satisfies RawAction,
  });
}
