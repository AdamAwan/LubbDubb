import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import { claimIsLive } from '../../validation/desktop.js';
import { failureBriefing, validationFailureBranch, validationFailureOrigin } from '../../validation/fleet.js';
import { validationGoalDir } from '../../validation/resources.js';
import { liveChecks } from '../../validation/verdict.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { Decision, ValidationCheck } from '../../types.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Look into a validation check that came back **failed**.
 *
 * ## The gap this closes
 *
 * A `failed` reading was a dead end. It wrote a note, flipped the goal's verdict
 * to `flagged`, put a row on the bench and waited — the one verdict in the
 * harness that says "the delivered thing does not work" and the only one that
 * scheduled nothing. Every other negative verdict has a consumer: an assessment
 * that says the goal was not reached reaches rule `issue-shortfall`, a red build
 * reaches rule `pr-ci-failing`. A person ran the procedure, watched it fail, and
 * the fleet did not look.
 *
 * ## Why it is not a shortfall
 *
 * The obvious wiring — record the failure as a shortfall and let the three arms
 * that already exist route it — is the one thing that must not happen here.
 * `VERDICT_EXCLUSIONS` has a shortfall clear the goal's **delivery**, which is
 * what parks it; and the delivery is what this whole feature stands on. Clearing
 * it un-parks the goal, settles the close-out obligation, and declines the
 * validation bench row as "the goal went back into production" — so a failed
 * check would delete the very rows it was reported into, and hand delivered work
 * back to the fleet. The two verdicts answer different questions: a shortfall
 * says the work is not finished, and a failed check says the finished work does
 * not do what somebody checked it for.
 *
 * ## What it dispatches, and what it deliberately does not
 *
 * A **read-only** code agent on the default branch — where the delivered work
 * is — to reproduce the failure and say what is behind it. It fixes nothing and
 * files nothing on its own authority: what a failed check needs first is a
 * diagnosis, and the three things the agent can honestly conclude already have
 * doors (`escalate` for a real defect somebody has to decide about,
 * `validation_amend` for a check that describes something that no longer exists,
 * `raise` for what the next agent should not have to rediscover).
 *
 * **It cannot record a reading, and that is structural rather than a sentence in
 * the prompt.** `validation_report` resolves its check from the dispatch origin,
 * and {@link validationFailureOrigin} is deliberately not one it parses — so an
 * agent that decides the check "actually passes" is refused by the tool. The
 * reading belongs to whoever took it.
 *
 * ## Where it sits
 *
 * Directly below rule `validate-check`, and for that rule's reason: validation's
 * standing promise is that it blocks nothing, so neither of its rules may take
 * the last slot from a blocked part or a red build. Below the run, too, because a
 * check waiting to be run is work nobody has done and this is a second opinion on
 * work somebody has.
 */
export function validationFailed(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    // Gated on the delivery for rule `validate-check`'s reason, arriving from the
    // other side: a `failed` reading taken against the delivered goal is a finding
    // about it, and one taken against half-built work is a finding about the
    // calendar. Only the first is worth an agent.
    if (!s.deliveryParked(issue)) continue;
    const origin = issueOrigin(issue.number);

    for (const check of liveChecks(s.validationChecks.get(origin) ?? [])) {
      if (check.state !== 'failed') continue;
      // The reading is what this dispatch is *about*, so a row without the instant
      // it was taken has nothing to diagnose against and nothing to bound the
      // budget with. Unreachable through `recordValidationResult`, which stamps
      // every state but `unrun`; guarded because the window below is only honest
      // while it holds.
      if (check.resultAt === null) continue;
      // Somebody is running it right now — a desktop session that took the check
      // back after seeing it fail. Its reading is about to replace the one this
      // would be sent to explain, and rule `validate-check` reads the claim the
      // same way for the same reason.
      if (claimIsLive(check, s.now, s.validationClaimMinutes)) continue;

      const checkOrigin = validationFailureOrigin(issue.number, check.id);
      const verdict = dispatchVerdict(checkOrigin, s.now, sinceReading(ctx.recentDecisions, check), s.cooldown);
      // Fails open and **silent**, rules `issue-retro` and `validate-check`'s rule:
      // nothing is gated on a check, so a spent cap costs the diagnosis and nothing
      // else. No escalation, because the operator is already being told — the check
      // is `failed`, the goal is flagged, and the close-out line quotes the note.
      if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

      const title = `Look into failed validation check ${check.letter} on issue #${issue.number}`;
      const reason =
        `Check ${check.letter} ("${check.title}") on issue #${issue.number} was run against the delivered ` +
        `goal and failed.`;
      s.candidates.push({
        origin: checkOrigin,
        rule: 'validation-failed',
        title,
        kind: 'code',
        branch: validationFailureBranch(issue.number, check.id),
        reason,
        held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
        action: {
          type: 'dispatch_code_agent',
          // The delivered work is on the default branch, so it is the only checkout
          // the failure can be reproduced in. Read-only: this agent is not fixing
          // anything, and a branch nothing opens a pull request from is a ref
          // nothing would ever reap.
          ...readOnlyDispatch(validationFailureBranch(issue.number, check.id), s.defaultBranch),
          title,
          // The check and the reading are **appended**, never interpolated: an
          // operator override that predates this rule would silently drop a new
          // token, and these are the two halves the agent cannot start without.
          prompt:
            s.templates.render('validation-failed', {
              number: issue.number,
              title: issue.title,
              letter: check.letter,
              root: validationGoalDir(s.validationRoot, origin),
            }) + failureBriefing(check),
          originRef: checkOrigin,
          originTitle: issue.title,
          originSummary: issue.body,
          rule: 'validation-failed',
          reason,
        } satisfies RawAction,
      });
    }
  }
}

/**
 * The cooldown's window: attempts made **before** this reading was taken are not
 * this reading's attempts.
 *
 * `plannerVerdict`'s adjustment, for the same reason and against the same
 * failure. A `failed` check stands until somebody records something else against
 * it, so an unnarrowed window would give a check one budget for its entire life:
 * a goal that failed, was fixed, was re-run and failed again would be met with a
 * spent attempt cap and no second look — the diagnosis silently stopping exactly
 * where a repeat failure makes it most worth having. Narrowed, each reading gets
 * its own three attempts, and a check nobody re-runs gets no more.
 *
 * The boundary is **strict**, `plannerVerdict`'s again: a decision stamped in the
 * same millisecond as the reading belongs to the dispatch that was already
 * running when the reading landed.
 */
function sinceReading(recentDecisions: Decision[], check: ValidationCheck): Decision[] {
  const since = Date.parse(check.resultAt ?? '');
  if (Number.isNaN(since)) return recentDecisions;
  return recentDecisions.filter((d) => Date.parse(d.createdAt) > since);
}
