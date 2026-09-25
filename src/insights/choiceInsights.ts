import type {
  FeatureSequence,
  IssueConclusion,
  IssueDelivery,
  IssueShortfall,
  Plan,
  Proposal,
  ValidationCheck,
} from '../types.js';

// → docs/spec/34-usage-metrics.md#who-decided

export type DecisionChoice =
  | 'pr-description'
  | 'plan'
  | 'validation-check'
  | 'goal-verdict'
  | 'goal-criteria'
  | 'watch-check'
  | 'state-query'
  | 'story-order';

type ChoiceSide = 'person' | 'agent';

const CHOICE_COPY: Record<DecisionChoice, { label: string; person: string; agent: string }> = {
  'pr-description': { label: 'PR description', person: 'written by a person', agent: 'the agent’s used' },
  plan: { label: 'Plan', person: 'sent back or closed', agent: 'the planner’s approved' },
  'validation-check': { label: 'Validation check', person: 'settled by a person', agent: 'settled by the fleet' },
  'goal-verdict': { label: 'Goal verdict', person: 'a person’s', agent: 'an agent’s' },
  'goal-criteria': { label: 'Goal criteria', person: 'written by a person', agent: 'the planner’s alone' },
  'watch-check': { label: 'Post-deploy watch', person: 'written by a person', agent: 'the plan’s' },
  'state-query': { label: 'State query', person: 'written by a person', agent: 'an agent’s, approved' },
  'story-order': { label: 'Story order', person: 'declined', agent: 'the sequencer’s accepted' },
};

const CHOICES = Object.keys(CHOICE_COPY) as DecisionChoice[];

export function choiceKey(choice: DecisionChoice, side: ChoiceSide): string {
  return `${choice}/${side}`;
}

export function choiceLabel(key: string): string {
  if (!isChoiceKey(key)) return key;
  const [choice, side] = key.split('/') as [DecisionChoice, ChoiceSide];
  return `${CHOICE_COPY[choice].label} — ${CHOICE_COPY[choice][side]}`;
}

export function isChoiceKey(key: string): boolean {
  const [choice, side] = key.split('/');
  return CHOICES.includes(choice as DecisionChoice) && (side === 'person' || side === 'agent');
}

interface ChoiceSighting {
  choice: DecisionChoice;
  side: ChoiceSide;
  at: string;
}

interface Authored {
  authored: string;
  createdAt: string;
}

export interface ChoiceInput {
  since: string;
  descriptionsWritten: readonly string[];
  draftsTaken: readonly string[];
  proposals: readonly Proposal[];
  checks: readonly ValidationCheck[];
  conclusions: readonly IssueConclusion[];
  deliveries: readonly IssueDelivery[];
  shortfalls: readonly IssueShortfall[];
  choicesOff: readonly DecisionChoice[];
  firstCriteria: readonly { originRef: string; at: string }[];
  plans: readonly Plan[];
  watches: readonly Authored[];
  queries: readonly Authored[];
  sequences: readonly FeatureSequence[];
}

type Sighted = readonly [ChoiceSide, string | null];

const by = (who: string): ChoiceSide => (who === 'operator' ? 'person' : 'agent');

const SWEEPS: Record<DecisionChoice, (input: ChoiceInput) => Sighted[]> = {
  'pr-description': (i) => [
    ...i.descriptionsWritten.map((at): Sighted => ['person', at]),
    ...i.draftsTaken.map((at): Sighted => ['agent', at]),
  ],
  plan: (i) =>
    i.proposals
      .filter((p) => p.kind === 'plan' && p.decidedBy === 'human' && p.status !== 'pending' && p.status !== 'withdrawn')
      .map((p) => [p.status === 'accepted' ? 'agent' : 'person', p.decidedAt]),
  'validation-check': (i) =>
    i.checks
      .filter((c) => (c.state === 'passed' || c.state === 'failed') && c.resultBy !== null)
      .map((c) => [by(c.resultBy ?? ''), c.resultAt]),
  'goal-verdict': (i) => [
    ...i.conclusions.map((c): Sighted => [by(c.by), c.updatedAt]),
    ...i.deliveries.map((d): Sighted => [by(d.by), d.updatedAt]),
    ...i.shortfalls.map((s): Sighted => [by(s.by), s.updatedAt]),
  ],
  'goal-criteria': criteriaSightings,
  'watch-check': (i) => i.watches.map((w) => [by(w.authored), w.createdAt]),
  'state-query': (i) => i.queries.map((q) => [by(q.authored), q.createdAt]),
  'story-order': (i) =>
    i.sequences
      .filter((s) => s.status !== 'proposed')
      .map((s) => [s.status === 'accepted' ? 'agent' : 'person', s.answeredAt]),
};

export function choiceSightings(input: ChoiceInput): ChoiceSighting[] {
  return CHOICES.filter((choice) => !input.choicesOff.includes(choice)).flatMap((choice) =>
    SWEEPS[choice](input)
      .filter((s): s is readonly [ChoiceSide, string] => s[1] !== null && s[1] >= input.since)
      .map(([side, at]) => ({ choice, side, at })),
  );
}

function criteriaSightings(input: ChoiceInput): Sighted[] {
  const written = new Map(input.firstCriteria.map((c) => [c.originRef, c.at]));
  const firstPlan = new Map<string, string>();
  for (const plan of input.plans) {
    const seen = firstPlan.get(plan.originRef);
    if (seen === undefined || plan.createdAt < seen) firstPlan.set(plan.originRef, plan.createdAt);
  }
  return [...firstPlan].map(([goal, plannedAt]) => {
    const at = written.get(goal);
    return [at !== undefined && at <= plannedAt ? 'person' : 'agent', plannedAt];
  });
}
