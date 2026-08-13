import type { AppState, Escalation, HumanTask, PlanPart, Proposal } from '../types.js';
import { goalIssue } from './goalPage.js';

/**
 * What kind of answer a row wants. `permission` and `proposal` are escalations
 * underneath, split out because the verdict differs: a permission goes to
 * `/permission`, a proposal carries accept/reject, and a plain question takes
 * free text. Drawing them as one kind is how a surface ends up offering the
 * wrong control.
 */
export type NeedKind = 'recovery' | 'escalation' | 'permission' | 'proposal' | 'bench' | 'close_out';

/**
 * Who is stopped. `blocking` means an agent is parked and cannot proceed;
 * `yours` means the obligation is the operator's and nothing is waiting inside
 * the fleet. Red/amber, and the split is strict — red means an agent is parked on
 * a question only you can answer, and nothing else.
 */
export type NeedGroup = 'blocking' | 'yours';

/**
 * What clicking a row opens. `goal` is the goal's page, where the ask is read
 * next to what it is about; `ask` is the ask on its own, for a row whose origin
 * is not a goal the console can draw — an escalation raised on a pull request, a
 * bench task with no ticket, a goal the world no longer carries. `null` is the
 * recovery hold alone, which is answered on the banner above the console.
 *
 * Decided in the derivation because only the derivation can tell a ref that *has*
 * a page from one that merely looks like it does. A rail that reads `goalRef`
 * instead draws a row whose click lands nowhere — which is indistinguishable, to
 * the operator, from a console that is broken.
 */
type NeedDestination = 'goal' | 'ask' | null;

/** One row of the merged queue. */
export interface NeedRow {
  /** The source row's own id, so answering it settles exactly this row. */
  id: string;
  kind: NeedKind;
  group: NeedGroup;
  /** The ask on one line. */
  title: string;
  /**
   * `issue:<n>` when the ask belongs to a goal; null for fleet-wide holds. This
   * is what the row *says* — where it goes is {@link NeedDestination}, since a
   * goal can be named by a ref the console has no page for.
   */
  goalRef: string | null;
  /** Where a click goes. */
  opens: NeedDestination;
  /** The parked agent, when there is one. */
  agentId: string | null;
  /** Live plan parts this ask is holding. Zero when it genuinely holds nothing. */
  holding: number;
  raisedAt: string;
}

/**
 * How many live parts named this slug — the same rule the bench station has
 * always used, lifted out so the queue, the goal page and the station cannot
 * disagree about what an ask is holding. Direct dependents only: a transitive
 * count would claim work that a sibling, not this ask, is the blocker for.
 */
export function partHolding(planId: string, slug: string, parts: readonly PlanPart[]): number {
  return parts.filter((p) => p.status !== 'retired' && p.planId === planId && p.dependsOn.includes(slug)).length;
}

/** The goal a ref belongs to, as `issue:<n>` — `issue:12:part:x` and `issue:12` both fold to `issue:12`. */
function goalOf(ref: string | null | undefined): string | null {
  const m = /^(issue:\d+)/.exec(ref ?? '');
  // noUncheckedIndexedAccess makes a capture group read as possibly undefined
  // even once `m` is non-null; the regex guarantees it's set when `m` matches.
  return m?.[1] ?? null;
}

function holdingForTask(task: HumanTask, parts: readonly PlanPart[]): number {
  if (!task.partId) return 0;
  const step = parts.find((p) => p.id === task.partId);
  return step ? partHolding(step.planId, step.slug, parts) : 0;
}

function holdingForEscalation(e: Escalation, state: AppState): number {
  const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
  const m = /^issue:\d+:part:(.+)$/.exec(originRef ?? '');
  if (!m) return 0;
  const step = (state.planParts ?? []).find((p) => p.slug === m[1]);
  return step ? partHolding(step.planId, step.slug, state.planParts ?? []) : 0;
}

function kindOf(e: Escalation, proposal: Proposal | undefined): NeedKind {
  if (e.context.permission) return 'permission';
  return proposal ? 'proposal' : 'escalation';
}

/**
 * Where an answerable row goes: its goal's page when that goal has one, and the
 * ask panel otherwise. Every row that can be answered gets one of the two — an
 * ask nothing opens is an ask nobody answers, and the fleet stays parked on it.
 */
function opensAt(goalRef: string | null, state: AppState): NeedDestination {
  return goalRef !== null && goalIssue(state, goalRef) !== undefined ? 'goal' : 'ask';
}

const GROUP_RANK: Record<NeedGroup, number> = { blocking: 0, yours: 1 };

/**
 * The merged queue, ordered. Recovery first because while it is up no pulse runs
 * at all, so every other row is waiting on it whether or not it says so. Then
 * blocking before yours, then whatever holds the most work, then oldest first.
 */
export function buildNeedsYou(state: AppState): NeedRow[] {
  const parts = state.planParts ?? [];
  const proposals = state.proposals ?? [];
  const rows: NeedRow[] = [];

  if ((state.recovery ?? []).length > 0) {
    rows.push({
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: `${state.recovery.length} runs were orphaned by a restart`,
      goalRef: null,
      // The one row with nowhere to go: the recovery banner above the console is
      // where it is answered, and it is already on screen.
      opens: null,
      agentId: null,
      holding: 0,
      raisedAt: '',
    });
  }

  for (const e of state.escalations.filter((x) => x.status === 'open')) {
    const proposal = proposals.find((p) => p.escalationId === e.id);
    const goalRef = goalOf(state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef);
    rows.push({
      id: e.id,
      kind: kindOf(e, proposal),
      group: 'blocking',
      title: e.prompt,
      goalRef,
      opens: opensAt(goalRef, state),
      agentId: e.agentId,
      holding: holdingForEscalation(e, state),
      raisedAt: e.createdAt,
    });
  }

  for (const t of (state.humanTasks ?? []).filter((x) => x.status === 'open')) {
    const goalRef = goalOf(t.originRef);
    rows.push({
      id: t.id,
      kind: t.kind === 'close_out' ? 'close_out' : 'bench',
      group: 'yours',
      title: t.title,
      goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      holding: holdingForTask(t, parts),
      raisedAt: t.createdAt,
    });
  }

  return rows.sort((a, b) => {
    if ((a.kind === 'recovery') !== (b.kind === 'recovery')) return a.kind === 'recovery' ? -1 : 1;
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (a.holding !== b.holding) return b.holding - a.holding;
    return a.raisedAt.localeCompare(b.raisedAt);
  });
}
