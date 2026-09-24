import type { AgentAskQuestion, CaveatAnswerInput, CheckDecline, Escalation, Proposal } from '../types.js';
import { checkSetOf } from '../checkSet.js';
import { planCaveatsOf } from '../planCaveats.js';

// → docs/spec/17-cockpit.md

type Context = Escalation['context'];

export interface CardProps {
  escalation: Escalation;
  proposal?: Proposal;
  resumedAt?: string | null;
  now?: number;
  refUrls: Record<string, string>;
  desktopFolder: string;
  onAnswer: (text: string) => Promise<unknown> | unknown;
  onAnswerQuestions?: (answers: (string | null)[]) => Promise<unknown> | unknown;
  onDecide?: (
    id: string,
    verdict: 'accept' | 'reject',
    note?: string,
    acknowledged?: string[],
    answers?: CaveatAnswerInput[],
    declined?: CheckDecline[],
  ) => Promise<unknown> | unknown;
  onBackOut?: (id: string, verdict: 'close' | 'hold', note?: string) => Promise<unknown> | unknown;
  onOverrule?: (issueNumber: number, proposalId: string, text: string) => Promise<unknown> | unknown;
  onPermission?: (id: string, allow: boolean, note?: string) => Promise<unknown> | unknown;
  onDismiss?: (id: string, note?: string) => Promise<unknown> | unknown;
  onOpenAgent?: (agentId: string) => void;
  onComplete?: (agentId: string) => Promise<unknown> | unknown;
  stallExpiresAt?: string | null;
  onExtend?: (agentId: string) => Promise<unknown> | unknown;
  onViewPlan?: (planId: string) => void;
  /**
   * Whether this ask's plan is still withheld pending the reveal. Handed in rather
   * than read here, because the card holds no plans — it is `PlanView.revealed`,
   * the one fact the wire carries for exactly this.
   */
  withheld?: boolean;
  /** Opens the goal on the pane the gate is drawn in. → docs/spec/17-cockpit.md#the-reveal-gate */
  onReveal?: () => void;
}

export type Card = ReturnType<typeof readCard>;

export function readCard(props: CardProps) {
  const { escalation, proposal, onAnswerQuestions, stallExpiresAt } = props;
  const { context } = escalation;
  const decidable = decidableOf(props);
  const caveats = planCaveatsOf(decidable ?? undefined);
  const planDecidable = planDecidableOf(decidable, props);
  const [headline, prose] = splitPrompt(escalation.prompt);
  return {
    signal: describeSignal(context.originRef, context.prNumber),
    permission: permissionOf(props),
    quick: agentOptions(context.options) ?? quickAnswers(escalation.prompt),
    questions: onAnswerQuestions ? questionnaire(context.questions) : null,
    decidable,
    caveats,
    planDecidable,
    gated: gatedOf(planDecidable, props),
    resumed: resumedOf(props),
    expiring: escalation.agentId && stallExpiresAt ? stallExpiresAt : null,
    headline,
    body: bodyOf(context, proposal, prose, caveats.length > 0),
    planId: planIdOf(props),
    /* A check set is a set, not a paragraph: it rides on the proposal as structure and is drawn as rows
       rather than through `context.detail`'s markdown. → docs/spec/17-cockpit.md */
    checkSet: checkSetOf(proposal),
    /* The goal number, from the escalation's context or from the origin it was
       raised on. Both spell the same goal, and only the first is always set: a card
       that has just the origin was dropping the Claude Code hand-off, which is the
       one answer here that needs the number. */
    issueNumber: goalNumber(context),
    overrulable: overrulableOf(decidable, props),
  };
}

function decidableOf({ proposal, onDecide }: CardProps): Proposal | null {
  return proposal?.status === 'pending' && onDecide ? proposal : null;
}

function planDecidableOf(decidable: Proposal | null, { onDecide, onBackOut }: CardProps): Proposal | null {
  return decidable?.kind === 'plan' && onDecide && onBackOut ? decidable : null;
}

function permissionOf({ escalation, onPermission }: CardProps): NonNullable<Context['permission']> | null {
  const { permission } = escalation.context;
  return permission && onPermission ? permission : null;
}

/* While the gate stands there is exactly one thing to do here and it is not on
   this card: approving, refusing and backing out are all refused server-side, and
   the sheet behind "Read the full plan" answers 409 — so the verdict row and both
   doors into the document are replaced by the one press that leads to the gate.
   A card offering four answers that each end in a refusal is the ask telling the
   operator to guess. → docs/spec/17-cockpit.md#the-reveal-gate */
function gatedOf(planDecidable: Proposal | null, { withheld, onReveal }: CardProps): boolean {
  return planDecidable !== null && withheld === true && onReveal !== undefined;
}

function resumedOf({ resumedAt, escalation }: CardProps): boolean {
  return resumedAt != null && Date.parse(resumedAt) > Date.parse(escalation.createdAt);
}

function bodyOf(context: Context, proposal: Proposal | undefined, prose: string, hasCaveats: boolean): string {
  const [ask, caution] = splitCaution(prose);
  const draftedBody = typeof context.draft === 'string' && ask.includes(context.draft.trim());
  if (proposal?.kind !== 'plan' && !draftedBody) return prose;
  return hasCaveats ? '' : caution;
}

function planIdOf({ proposal, onViewPlan, escalation }: CardProps): string | null {
  const { planId } = escalation.context;
  return proposal?.kind === 'plan' && onViewPlan && typeof planId === 'string' ? planId : null;
}

function overrulableOf(
  decidable: Proposal | null,
  { onOverrule, escalation }: CardProps,
): { proposalId: string; issueNumber: number } | null {
  const { issueNumber } = escalation.context;
  return decidable?.kind === 'shortfall' && onOverrule && typeof issueNumber === 'number'
    ? { proposalId: decidable.id, issueNumber }
    : null;
}

function splitPrompt(prompt: string): [headline: string, body: string] {
  const at = prompt.search(/\r?\n\s*\r?\n/);
  return at === -1 ? [prompt.trim(), ''] : [prompt.slice(0, at).trim(), prompt.slice(at).trim()];
}

function splitCaution(body: string): [prose: string, caution: string] {
  const at = body.search(/(^|\n)Before you decide:/);
  return at === -1 ? [body, ''] : [body.slice(0, at).trim(), body.slice(at).trim()];
}

function goalNumber(context: Record<string, unknown>): number | null {
  if (typeof context.issueNumber === 'number') return context.issueNumber;
  const origin = typeof context.originRef === 'string' ? /^issue:(\d+)/.exec(context.originRef) : null;
  return origin ? Number(origin[1]) : null;
}

function describeSignal(originRef?: string | null, prNumber?: number): string | null {
  if (typeof prNumber === 'number') return `PR #${prNumber}`;
  if (!originRef) return null;
  const [kind, id, sub] = originRef.split(':');
  switch (kind) {
    case 'pr':
      return sub === 'ci' ? `PR #${id} · CI` : `PR #${id} · review comment`;
    case 'issue':
      return `Issue #${id}`;
    default:
      return originRef;
  }
}

const YESNO = /\b(should|shall|can|may|is it ok|ok to|approve|proceed|do you want|would you like)\b/i;

function quickAnswers(prompt: string): string[] {
  return prompt.includes('?') && YESNO.test(prompt) ? ['Yes', 'No'] : [];
}

function agentOptions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const options = value.filter((o): o is string => typeof o === 'string' && o.trim() !== '');
  return options.length > 0 ? options : null;
}

function questionnaire(value: unknown): AgentAskQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions = value.flatMap((raw): AgentAskQuestion[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const entry: Record<string, unknown> = raw;
    if (typeof entry.question !== 'string' || entry.question.trim() === '') return [];
    const options = agentOptions(entry.options);
    return [
      {
        question: entry.question,
        ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
        ...(options ? { options } : {}),
      },
    ];
  });
  return questions.length > 0 ? questions : null;
}
