import type { AgentModels } from '../agents/modelPolicy.js';
import type { ErrorRecorder } from '../errorLog.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { modelLabelsFor } from '../modelLabels.js';
import type { IssueLabelInput, SendResult } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';

/**
 * Pinning a goal to a model profile, in one place — `src/issueWatch.ts`'s
 * arrangement, for its reason and one more of its own.
 *
 * Two surfaces reach it: the cockpit's `POST /api/issues/:number/profile` and the
 * desktop channel's `goal_control`. The desktop half is why this module exists
 * rather than the route keeping its copy. `goal_control` grew a `profile` arm that
 * wrote `setProfileOverride` — the *queue's* per-origin price, which is a
 * different record with a different lifetime — so an operator answering the
 * profile question from their own Claude Code priced one queued row, left the
 * ticket untagged, left the appraisal's question unanswered, and got a reply
 * saying the pin was written. The gate went on holding the goal with nothing red,
 * which is the failure this repo keeps a module like this one to end.
 *
 * The two halves that must not come apart:
 *
 * - **The tag is the answer.** One profile's label goes on and every other one
 *   comes off, so the ticket carries at most one — the same sweep "watch" makes
 *   over "ignore", and the reason dispatch does one lookup rather than ranking
 *   sources. → `src/modelLabels.ts`
 * - **The question is settled either way.** {@link Store.answerAppraisalProfile}
 *   records *that* the operator answered, never what with — the tag is what they
 *   answered with, and a second copy of it here would be free to drift. It is
 *   what makes "keep mine" work: the tag deliberately lands disagreeing with the
 *   appraiser, and a gate that re-read the disagreement would ask for ever.
 *   → `src/intake/appraisal.ts`, `docs/spec/06-issue-pickup.md`
 *
 * A partial sweep is reported rather than swallowed, and the caller republishes
 * before refusing: some labels have already changed, so the world the cockpit is
 * showing is stale whichever way this ends.
 */
interface ProfilePinContext {
  store: Pick<Store, 'getAppraisal' | 'answerAppraisalProfile'>;
  /** The outbound seam — `system.connector` for a route, the same one `applyIssueWatch` takes. */
  sink: { setIssueLabel(input: IssueLabelInput): Promise<SendResult> };
  /** Optional only because the desktop channel's server may be built without one. */
  errors?: ErrorRecorder;
  labelPrefix: string;
  agentModels: AgentModels | undefined;
}

type ProfilePinOutcome =
  | { ok: true; profile: string | null; answered: boolean }
  | { ok: false; error: string; wrote: boolean };

/**
 * Write the pin, or say why it was refused.
 *
 * `wanted` is `null` to clear it — "no profile" is the state a ticket starts in,
 * not a third value.
 *
 * Refused **by name** before anything is written, exactly as config is refused at
 * boot: those are the two halves of one rule. A hand-typed label naming nothing is
 * tolerated because a human wrote it on a ticket the harness cannot police
 * (`resolveModelTag`); a caller that can only send what the harness offered it is
 * not, because a profile that resolves to nothing prices nothing while reading as
 * a decision taken.
 */
export async function applyProfilePin(
  ctx: ProfilePinContext,
  issueNumber: number,
  wanted: string | null,
): Promise<ProfilePinOutcome> {
  const labels = modelLabelsFor(ctx.labelPrefix, ctx.agentModels);
  if (labels.length === 0)
    return {
      ok: false,
      wrote: false,
      error: 'This deployment configures no agentModels.profiles, so there is nothing to pin to.',
    };
  if (wanted !== null && !labels.some((l) => l.profile === wanted))
    return {
      ok: false,
      wrote: false,
      error: `"${wanted}" is not one of this deployment's profiles: ${labels.map((l) => l.profile).join(', ')}.`,
    };

  let wrote = false;
  for (const { profile, label } of labels) {
    try {
      await ctx.sink.setIssueLabel({ number: issueNumber, label, present: profile === wanted });
      wrote = true;
    } catch (err) {
      const message = (err as Error).message;
      ctx.errors?.record({
        source: 'server',
        message: `Failed to set the model tag on #${issueNumber}: ${message}`,
      });
      return { ok: false, error: message, wrote };
    }
  }

  // The answer, if a proposal was waiting on one. Keyed on the row's own
  // fingerprint so it settles the question the operator was actually shown.
  const origin = issueConclusionOrigin(issueNumber);
  const appraisal = ctx.store.getAppraisal(origin);
  const answered = appraisal !== null && ctx.store.answerAppraisalProfile(origin, appraisal.goalRef);
  return { ok: true, profile: wanted, answered };
}
