import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import { claimIsLive } from '../../validation/desktop.js';
import { checkBriefing, validateBranch, validateOrigin } from '../../validation/fleet.js';
import { validationGoalDir } from '../../validation/resources.js';
import { liveChecks } from '../../validation/verdict.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Run a validation check the operator handed to the fleet.
 *
 * **The hand-over is the whole gate.** Every check is a person's until they say
 * otherwise: the planner's `fleetCandidate` is a nomination that dispatches
 * nothing, because whether an agent *can* run a check is a property of the
 * deployment — what logins it has, whether anything can drive a browser — which
 * a planner reading the repository cannot know. This rule reads the operator's
 * answer to that question and nothing else.
 *
 * **It is last in the pipeline, and that is load-bearing.** Validation's
 * standing promise is that it blocks nothing; a rule that could take the last
 * slot from a blocked part or a failing build would make the one feature that
 * gates nothing the reason something else did not run. Ranked last, a handed-over
 * check gets the headroom nothing else wanted, and stays visible in the queue as
 * `waiting` when there is none.
 */
export function validateCheck(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    // Deliberately **not** gated on `retained` — with `issue-assess` and
    // `issue-retro` this is a rule that runs after the work is over, which is
    // exactly when a delivering PR has already closed the ticket. The run is
    // what a check belongs to, not the tracker's answer.
    //
    // Gated on the delivery instead, and that is the substantive condition: a
    // check is executed against the *delivered* goal. Run against half-built
    // work it produces a `failed` reading about something that does not exist
    // yet — a finding about the calendar rather than about the code, and the
    // most expensive kind of wrong result this feature can produce.
    if (!s.deliveryParked(issue)) continue;
    const origin = issueOrigin(issue.number);

    for (const check of liveChecks(s.validationChecks.get(origin) ?? [])) {
      // Two facts, and both are somebody's decision rather than the harness's:
      // the operator handed this check over, and nobody has recorded a reading
      // against it. A check that is `passed`, `failed`, `waived` or `deferred`
      // carries a settled reading, and re-running one behind the person who
      // settled it would overwrite their answer with an agent's.
      if (check.actor !== 'fleet' || check.state !== 'unrun') continue;
      // And a third, which is somebody *currently* running it rather than a
      // decision about who should. A desktop session claims a check before it
      // starts; dispatching an agent underneath one would put two things in the
      // same environment against the same procedure, and the second reading would
      // overwrite the first without either knowing the other existed.
      //
      // Read through `claimIsLive` rather than off `claimedBy`, so a claim whose
      // session died means the same thing here as it does to the person trying to
      // take it — otherwise a killed session blocks a check from the fleet forever.
      if (claimIsLive(check, s.now, s.validationClaimMinutes)) continue;

      const checkOrigin = validateOrigin(issue.number, check.id);
      const verdict = dispatchVerdict(checkOrigin, s.now, ctx.recentDecisions, s.cooldown);
      // Fails open and **silent**, `issue-retro`'s rule: nothing is gated on a
      // check, so a spent cap costs the run and nothing else. No escalation,
      // because the operator is already going to be told — the check is still
      // `unrun`, the goal is still flagged, and the close-out line says the
      // check is with the fleet. A second inbox item would ask the same person
      // the same question twice.
      if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

      const title = `Run validation check ${check.letter} on issue #${issue.number}`;
      const reason = `Check ${check.letter} ("${check.title}") on issue #${issue.number} was handed to the fleet and has not been run.`;
      s.candidates.push({
        origin: checkOrigin,
        rule: 'validate-check',
        title,
        kind: 'code',
        branch: validateBranch(issue.number, check.id),
        reason,
        held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
        action: {
          type: 'dispatch_code_agent',
          branch: validateBranch(issue.number, check.id),
          // The delivered work is *on* the default branch, so it is the only
          // checkout the check can be run in — `issue-assess`'s argument, and
          // for the same reason it is not the issue's own branch.
          base: s.defaultBranch,
          title,
          // The check itself is **appended**, never interpolated: an operator
          // override that predates this rule would silently drop a new token,
          // and the procedure is the half the agent cannot act without.
          prompt:
            s.templates.render('validation-check', {
              number: issue.number,
              title: issue.title,
              letter: check.letter,
              root: validationGoalDir(s.validationRoot, origin),
            }) + checkBriefing(check),
          originRef: checkOrigin,
          originTitle: issue.title,
          originSummary: issue.body,
          rule: 'validate-check',
          reason,
        } satisfies RawAction,
      });
    }
  }
}
