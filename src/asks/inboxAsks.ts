import type { Escalation, HumanTask, PlanPart, Proposal } from '../types.js';
import type { SetupReading, SetupVerdict } from '../setup/reading.js';
import type { AskKind } from './askRow.js';
import type { AskDraft, AskInputs } from './queue.js';
import { agentLabelOf, askLine, goalOf, oneLine, opensAt, predictionOpensAt } from './lines.js';

// → docs/spec/17-cockpit.md#the-queue-rail--needs-you

export function partHolding(planId: string, slug: string, parts: readonly PlanPart[]): number {
  return parts.filter((p) => p.status !== 'retired' && p.planId === planId && p.dependsOn.includes(slug)).length;
}

function commentAuthor(state: AskInputs, prNumber: unknown, commentId: unknown): string | null {
  if (typeof prNumber !== 'number' || typeof commentId !== 'string') return null;
  const pr = state.world.pullRequests.find((p) => p.number === prNumber);
  return pr?.unresolvedComments.find((c) => c.id === commentId)?.author ?? null;
}

function isShortfallAsk(originRef: string | null): boolean {
  return /^issue:\d+:shortfall$/.test(originRef ?? '');
}

/** The check titles as the proposal put them, read off its own action. */
function proposedCheckTitles(proposal: Proposal): string[] {
  const action = proposal.action as Record<string, unknown>;
  const raw: unknown[] = Array.isArray(action.set) ? action.set : [];
  const titles: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { letter, title } = entry as Record<string, unknown>;
    if (typeof letter === 'string' && letter !== '' && typeof title === 'string' && title !== '') titles.push(title);
  }
  return titles;
}

/** → docs/spec/17-cockpit.md#a-check-set-ask-is-named-by-its-checks */
function checkSetLine(proposal: Proposal): string {
  const titles = proposedCheckTitles(proposal);
  const [first] = titles;
  if (first === undefined) return 'No checks proposed — agree nothing needs running?';
  const rest = titles.length - 1;
  return `OK ${titles.length === 1 ? 'check' : `${titles.length} checks`}: ${first}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

function escalationSummary(
  e: Escalation,
  proposal: Proposal | undefined,
  originRef: string | null,
  state: AskInputs,
): string {
  const { context } = e;
  const pr = typeof context.prNumber === 'number' ? ` for PR #${context.prNumber}` : '';
  if (proposal) {
    switch (proposal.kind) {
      case 'plan':
        return 'Plan ready';
      case 'plan_amendment':
        return 'Change to a running plan';
      case 'reply_draft': {
        const author = commentAuthor(state, context.prNumber, context.commentId);
        return `Draft reply${author === null ? '' : ` to ${author}`}${pr}`;
      }
      case 'merge':
        return `Merge waiting on your verdict${pr}`;
      case 'shortfall':
        return 'The delivered work did not reach the goal';
      case 'validation_plan':
        return checkSetLine(proposal);
    }
  }
  if (context.permission) return oneLine(`${context.permission.toolName}: ${context.permission.summary}`);
  if (isShortfallAsk(originRef)) return 'Assessed as not delivered';
  const questions = Array.isArray(context.questions) ? context.questions.length : 0;
  if (questions > 0) return `${questions} questions from the agent`;
  return oneLine(e.prompt);
}

function holdingForTask(task: HumanTask, parts: readonly PlanPart[]): number {
  if (!task.partId) return 0;
  const step = parts.find((p) => p.id === task.partId);
  return step ? partHolding(step.planId, step.slug, parts) : 0;
}

function holdingForEscalation(originRef: string | null, state: AskInputs): number {
  const m = /^issue:\d+:part:(.+)$/.exec(originRef ?? '');
  if (!m) return 0;
  const step = (state.planParts ?? []).find((p) => p.slug === m[1]);
  return step ? partHolding(step.planId, step.slug, state.planParts ?? []) : 0;
}

/* `validation_plan` is its own kind rather than `validate`: that one is a bench task, read out of
   `humanTasks` by the row's id. */
const PROPOSAL_KIND: Record<Proposal['kind'], AskKind> = {
  plan: 'plan',
  plan_amendment: 'plan',
  reply_draft: 'reply',
  merge: 'merge',
  shortfall: 'shortfall',
  validation_plan: 'validation_plan',
};

function kindOf(e: Escalation, proposal: Proposal | undefined, originRef: string | null): AskKind {
  if (e.context.permission) return 'permission';
  if (proposal) return PROPOSAL_KIND[proposal.kind];
  return isShortfallAsk(originRef) ? 'shortfall' : 'escalation';
}

const TASK_KIND: Record<HumanTask['kind'], AskKind> = {
  ask: 'bench',
  close_out: 'close_out',
  outcome: 'close_out',
  validate: 'validate',
  watch: 'watch',
  unwatched: 'unwatched',
  burn: 'burn',
  supply: 'supply',
};

/**
 * While the reveal gate stands the plan cannot be answered where the row is drawn — approving,
 * refusing and backing out are all refused server-side — so the row goes to the gate instead.
 * → docs/spec/16-http-api.md#the-plan-body-is-withheld-until-it-is-revealed
 */
function planWithheld(e: Escalation, state: AskInputs): boolean {
  const { planId } = e.context;
  if (typeof planId !== 'string') return false;
  return (state.plans ?? []).some((p) => p.id === planId && !p.revealed);
}

const REVEAL_NOTE = 'Withheld — reveal it to read it, and the prediction is asked first';

export function escalationRows(state: AskInputs): AskDraft[] {
  const proposals = state.proposals ?? [];
  return state.escalations
    .filter((x) => x.status === 'open')
    .map((e) => {
      const proposal = proposals.find((p) => p.escalationId === e.id);
      const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
      const goalRef = goalOf(originRef, state);
      const withheld = planWithheld(e, state);
      return {
        id: e.id,
        kind: kindOf(e, proposal, originRef),
        subject: {
          type: 'escalation' as const,
          escalationId: e.id,
          proposalId: proposal?.id ?? null,
          ...(withheld ? { planWithheld: true as const } : {}),
        },
        group: 'blocking' as const,
        title: askLine(escalationSummary(e, proposal, originRef, state), goalRef, state),
        goalRef,
        originRef,
        opens: withheld ? predictionOpensAt(goalRef, state) : opensAt(goalRef, state),
        ...(withheld ? { note: REVEAL_NOTE } : {}),
        agentId: e.agentId,
        agentLabel: agentLabelOf(e.agentId, state),
        holding: holdingForEscalation(originRef, state),
        raisedAt: e.createdAt,
      };
    });
}

export function humanTaskRows(state: AskInputs): AskDraft[] {
  const parts = state.planParts ?? [];
  return (state.humanTasks ?? [])
    .filter((x) => x.status === 'open')
    .map((t) => {
      const goalRef = goalOf(t.originRef, state);
      return {
        id: t.id,
        kind: TASK_KIND[t.kind],
        subject: { type: 'human_task' as const, taskId: t.id },
        group: 'yours' as const,
        title: askLine(oneLine(t.title), goalRef, state),
        goalRef,
        originRef: t.originRef ?? null,
        opens: opensAt(goalRef, state),
        agentId: t.kind === 'burn' ? t.agentId : null,
        agentLabel: t.kind === 'burn' ? agentLabelOf(t.agentId, state) : null,
        holding: holdingForTask(t, parts),
        raisedAt: t.createdAt,
      };
    });
}

export function limitRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const agentId of state.parkedOnLimit) {
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) continue;
    const originRef = state.tasks.find((t) => t.id === agent.taskId)?.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: agentId,
      kind: 'limit',
      subject: { type: 'parked_agent', agentId },
      group: 'blocking',
      title: askLine(oneLine(agent.waitingReason ?? 'Parked: no usage allowance left right now.'), goalRef, state),
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId,
      agentLabel: agentLabelOf(agentId, state),
      holding: 0,
      raisedAt: agent.startedAt,
    });
  }
  return rows;
}

export function recoveryRows(state: AskInputs): AskDraft[] {
  const recovery = state.recovery ?? [];
  if (recovery.length === 0) return [];
  return [
    {
      id: 'recovery',
      kind: 'recovery',
      subject: { type: 'recovery', taskIds: recovery.map((r) => r.taskId) },
      group: 'blocking',
      title: `${recovery.length} runs were orphaned by a restart`,
      goalRef: null,
      originRef: null,
      opens: null,
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: '',
    },
  ];
}

const KIND_FOR_VERDICT: Record<SetupVerdict, AskKind | null> = {
  bad: 'config',
  warn: 'config_gap',
  ok: null,
  unknown: null,
};

/**
 * One row per setup check. A check reading `ok` or `unknown` is shipped as well, not standing, so
 * a fix the operator just applied keeps its place while its undo is drawn.
 */
export function configRows(setup: SetupReading | null): AskDraft[] {
  if (setup === null) return [];
  return setup.checks.map((check) => {
    const kind = KIND_FOR_VERDICT[check.verdict];
    return {
      id: `setup:${check.id}`,
      kind: kind ?? 'config_gap',
      subject: { type: 'setup_check' as const, checkId: check.id },
      standing: kind !== null,
      group: 'yours' as const,
      title: check.detail,
      goalRef: null,
      originRef: null,
      opens: 'config' as const,
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: '',
      check,
    };
  });
}
