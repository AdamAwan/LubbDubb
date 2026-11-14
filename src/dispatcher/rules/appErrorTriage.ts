import { appErrorTriageBranch, appErrorTriageOrigin } from '../../appErrors/triageOrigin.js';
import { readOnlyDispatch, readOnlyNote } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/39-app-errors.md#agent-triage

export function appErrorTriage(s: StageContext): void {
  const run = s.appErrorTriageRun;
  if (run === null) return;
  const origin = appErrorTriageOrigin(run.id);
  if (s.activeOrigins.has(origin)) return;
  const count = run.subjects.length;
  const branch = appErrorTriageBranch(run.id);
  const title = `Triage ${count === 1 ? 'one app error' : `${String(count)} app errors`} nothing linked`;
  const reason =
    run.trigger === 'operator'
      ? 'Somebody pressed Triage on an Errors row.'
      : `${count === 1 ? 'One error group' : `${String(count)} error groups`} moved, and the deterministic link named no goal for ${count === 1 ? 'it' : 'them'}.`;
  s.candidates.push({
    origin,
    rule: 'app-error-triage',
    title,
    kind: 'code',
    branch,
    reason,
    action: {
      type: 'dispatch_code_agent',
      ...readOnlyDispatch(branch, s.defaultBranch),
      title,
      prompt:
        s.templates.render('app-error-triage', { count }) +
        readOnlyNote('Your verdicts need neither: app_error_triage records them directly.') +
        run.briefing,
      appErrorTriageRun: { id: run.id },
      originRef: origin,
      originTitle: title,
      originSummary: null,
      rule: 'app-error-triage',
      reason,
    } satisfies RawAction,
  });
}
