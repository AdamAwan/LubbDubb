import type { AgentModels } from '../agents/modelPolicy.js';
import type { ErrorRecorder } from '../errorLog.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { modelLabelsFor } from '../modelLabels.js';
import type { IssueLabelInput, SendResult } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';

// → docs/spec/06-issue-pickup.md

interface ProfilePinContext {
  store: Pick<Store, 'verdicts'>;
  sink: { setIssueLabel(input: IssueLabelInput): Promise<SendResult> };
  errors?: ErrorRecorder;
  labelPrefix: string;
  agentModels: AgentModels | undefined;
}

type ProfilePinOutcome =
  | { ok: true; profile: string | null; answered: boolean }
  | { ok: false; error: string; wrote: boolean };

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

  const origin = issueConclusionOrigin(issueNumber);
  const appraisal = ctx.store.verdicts.getAppraisal(origin);
  const answered = appraisal !== null && ctx.store.verdicts.answerAppraisalProfile(origin, appraisal.goalRef);
  return { ok: true, profile: wanted, answered };
}
