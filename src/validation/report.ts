import { z } from 'zod';
import { validateOriginParts } from './fleet.js';

/**
 * The `validation_report` tool's pure layer: who may report on a check, what
 * they may say about it, and how the three answers differ.
 *
 * ## Why the fence here is the narrow kind
 *
 * `validationAmendIssue` is deliberately wide — any agent working a goal may
 * point out that a check is wrong, because a check is a note about how the goal
 * gets tested and the agent best placed to notice a stale one is whoever is
 * looking at the code. **A result is not that.** It is a reading, cast about a
 * procedure somebody was asked to carry out, and it is the one thing on the row
 * an operator will later act on without repeating the work. So this fence is
 * `conclusionOrigin`'s shape rather than the amendment's: exactly the agent
 * dispatched for exactly this check, refused by name otherwise.
 *
 * The refusal matters most for the caller it is most tempting for — the agent
 * that just built the thing. It has every reason to believe the goal works and
 * no way to have run a check nobody sent it to run, which is the definition of a
 * result derived from incidental evidence.
 *
 * ## Why there are three answers and not two
 *
 * A dispatched agent that cannot reach the environment has learned nothing about
 * the goal. With only `passed` and `failed` available its options are a lie and
 * silence, and both are worse than the truth: `failed` flags a goal for a reason
 * that has nothing to do with the code, and silence leaves a check `unrun` with
 * no account of why. `handback` records no reading, returns the check to the
 * operator and carries the agent's reason to them.
 */

/**
 * The goal and the check this caller may report on, or a refusal that names the
 * tool it actually wants.
 *
 * Taken from the task's origin, never from an argument: the credential resolves
 * to an agent, the agent to its task, and the task to the origin it was
 * dispatched on (`token -> agent -> task -> origin`). An agent therefore cannot
 * report against a check it was not sent to run by asking to.
 */
export function validationReportTarget(
  originRef: string | null,
): { ok: true; issueNumber: number; checkId: string } | { ok: false; error: string } {
  const target = validateOriginParts(originRef);
  if (target) return { ok: true, ...target };
  const ref = originRef ?? '';
  return {
    ok: false,
    error:
      `validation_report records the reading of one validation check, and only the agent dispatched to run that ` +
      `check may record it. This task's origin is ${ref || '(none)'}, not issue:<n>:validate:<checkId>. ` +
      `If you believe a check is wrong — it names a screen that moved, or a command that was renamed — correct ` +
      `its wording with validation_amend instead; that is open to every agent working the goal. A check nobody ` +
      `sent you to run is not one you can have run.`,
  };
}

/**
 * **The check is not an argument.** It is on the origin, one check per dispatch,
 * so which check a report is about is decided by what the agent was sent to do
 * rather than by what it says it did. Accepting an id here and comparing it back
 * would add a way to be wrong about something that was never in doubt.
 */
const ReportSchema = z
  .object({
    result: z.enum(['passed', 'failed', 'handback'], {
      required_error: 'result must be "passed", "failed" or "handback"',
      invalid_type_error: 'result must be "passed", "failed" or "handback"',
    }),
    // Required on all three arms, `conclude_work`'s rule and the routes' rule:
    // a reading an operator acts on later must not be a state with no account of
    // itself, and a hand-back with no reason is indistinguishable from an agent
    // that gave up.
    note: z
      .string({ required_error: 'note is required — say what you saw', invalid_type_error: 'note is required' })
      .trim()
      .min(1, 'note is required — say what you saw'),
  })
  .strict('a report declares only "result" and "note" — which check is decided by what you were dispatched to run');

type ParsedReport = z.infer<typeof ReportSchema>;

export function validateReport(args: unknown): { ok: true; report: ParsedReport } | { ok: false; error: string } {
  const parsed = ReportSchema.safeParse(args);
  if (parsed.success) return { ok: true, report: parsed.data };
  const first = parsed.error.errors[0];
  return { ok: false, error: first ? first.message : 'the report could not be read' };
}

/**
 * How a hand-back reads on the row an operator will see it on.
 *
 * `by` is on the sentence because the two hand-backs mean different things to
 * the person reading the row: a fleet agent gave up on a check somebody handed
 * it, and their own desktop session gave up on a check they went and took. The
 * first is a question about the deployment; the second is one about the check.
 */
export function handbackReason(reason: string, by: 'agent' | 'desktop'): string {
  const who = by === 'desktop' ? 'A desktop session' : 'An agent';
  return `${who} could not run this check: ${reason}`;
}
