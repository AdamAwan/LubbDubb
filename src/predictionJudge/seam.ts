import { PREDICTION_SLOTS, type PredictionStore } from '../store/predictions.js';
import type { Store } from '../store/store.js';
import type { GoalPrediction, Plan, PlanPart, PredictionMark, PredictionSlot } from '../types.js';

// → docs/spec/14-persistence.md#the-prediction-judge

/**
 * The one path a prediction takes to a model. Handed by the composition root to the
 * `prediction_judge` tool alone, so no module the fleet is handed names the store:
 * the tool asks this for the brief and hands its marks back through it.
 */
interface JudgeSeam {
  brief(originRef: string): string | null;
  record(
    originRef: string,
    marks: Partial<Record<PredictionSlot, PredictionMark | null>>,
  ): { ok: true } | { ok: false; error: string };
}

const QUESTIONS: Record<PredictionSlot, string> = {
  locus: 'Where the change would land',
  cause: 'What was actually wrong',
  split: 'How the work would be divided',
  avoid: 'What the plan should not do',
};

export function judgeSeam(predictions: PredictionStore, store: Store): JudgeSeam {
  return {
    brief(originRef) {
      const prediction = predictions.getPrediction(originRef);
      const plan = store.plans.getPlanByOrigin(originRef);
      if (prediction === null || plan === null) return null;
      return judgeBrief(prediction, plan, store.plans.listPlanParts(plan.id));
    },
    record(originRef, marks) {
      const outcome = predictions.recordJudgeMarks({ originRef, marks });
      return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
    },
  };
}

function judgeBrief(prediction: GoalPrediction, plan: Plan, parts: PlanPart[]): string {
  const slots = PREDICTION_SLOTS.map((slot) => {
    const text = prediction.slots[slot];
    return `### ${slot} — ${QUESTIONS[slot]}\n\n${text ?? '(skipped — do not mark this slot)'}`;
  });
  const narrative = (
    [
      ['Diagnosis', plan.diagnosis],
      ['Approach', plan.approach],
      ['Reason', plan.reason],
      ['Risks', plan.risks],
      ['Out of scope', plan.outOfScope],
    ] as const
  )
    .filter(([, text]) => text !== null && text.trim() !== '')
    .map(([label, text]) => `**${label}:** ${text}`);
  const live = parts.filter((p) => p.status !== 'retired');
  const partLines = live.map((p) => `- \`${p.slug}\` — ${p.title}: ${p.scope}`);
  return [
    '## The prediction',
    '',
    slots.join('\n\n'),
    '',
    '## The plan',
    '',
    narrative.join('\n\n') || '(the plan carries no narrative)',
    '',
    `### Its ${live.length} part${live.length === 1 ? '' : 's'}`,
    '',
    partLines.join('\n') || '(none)',
  ].join('\n');
}
