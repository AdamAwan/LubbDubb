import type { AppState, Escalation, HumanTask, PlanPart, Proposal } from '../types.js';
import { goalIssue, goalOfPr } from './goalPage.js';

/**
 * What kind of answer a row wants. `permission` and `proposal` are escalations
 * underneath, split out because the verdict differs: a permission goes to
 * `/permission`, a proposal carries accept/reject, and a plain question takes
 * free text. Drawing them as one kind is how a surface ends up offering the
 * wrong control.
 */
export type NeedKind = 'recovery' | 'escalation' | 'permission' | 'proposal' | 'bench' | 'close_out' | 'burn' | 'limit';

/**
 * Who is stopped. `blocking` means an agent is parked and cannot proceed;
 * `yours` means the obligation is the operator's and nothing is waiting inside
 * the fleet. Red/amber, and the split is strict — red means an agent is parked
 * and only you can un-park it, and nothing else.
 *
 * A usage-limit park (issue #318) is `blocking` for that reason and not by
 * analogy: the agent is stopped, its worktree and its slot are held, and the
 * harness will not resume it on its own. What differs from a question is only
 * *what* the operator does — wait for the window to turn over, then resume.
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
  /**
   * The ref the ask was actually raised on (`pr:142`, `issue:12:part:signer`), as
   * the harness recorded it. Kept beside {@link goalRef} rather than folded into
   * it because the two answer different questions: `goalRef` is the goal the ask
   * is read *next to*, and this is what it is *about*. A row with no goal has one
   * of these or nothing at all, and the ask panel draws it — an ask whose subject
   * a surface cannot name is one the operator answers blind.
   */
  originRef: string | null;
  /** Where a click goes. */
  opens: NeedDestination;
  /**
   * The agent this row is about, when there is one — the parked agent on an
   * escalation or a limit park, the spending one on a burn notice. Never the
   * agent that merely raised the row: a bystander's id beside an ask reads as the
   * thing to go and look at.
   */
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

/**
 * The goal a ref belongs to, as `issue:<n>`.
 *
 * `issue:12:part:x` and `issue:12` both fold to `issue:12`. A **`pr:<n>`** origin
 * is resolved through the world (`goalOfPr`): the goal page is where an ask is
 * meant to be read, and most asks the harness raises come from a pull request, so
 * reading only the literal prefix sent every rebase and CI question to a panel
 * with no context around it while the goal that PR belongs to sat one lookup away.
 * Null survives for a pull request no ticket owns — the harness works those too,
 * and there is no goal to invent for them.
 */
function goalOf(ref: string | null | undefined, state: AppState): string | null {
  const m = /^(issue:\d+)/.exec(ref ?? '');
  // noUncheckedIndexedAccess makes a capture group read as possibly undefined
  // even once `m` is non-null; the regex guarantees it's set when `m` matches.
  if (m?.[1]) return m[1];
  const pr = /^pr:(\d+)/.exec(ref ?? '');
  return pr?.[1] ? goalOfPr(state, Number(pr[1])) : null;
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
 * Which row kind a human task draws as.
 *
 * A total map rather than a pair of ternaries, so a new {@link HumanTaskKind}
 * fails the typecheck here instead of silently drawing as a bench task — which is
 * how the harness's own self-settling rows end up wearing the copy for the ones
 * only a person can close.
 */
const TASK_KIND: Record<HumanTask['kind'], NeedKind> = {
  ask: 'bench',
  close_out: 'close_out',
  burn: 'burn',
};

function needKindOfTask(kind: HumanTask['kind']): NeedKind {
  return TASK_KIND[kind];
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
      originRef: null,
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
    const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: e.id,
      kind: kindOf(e, proposal),
      group: 'blocking',
      title: e.prompt,
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId: e.agentId,
      holding: holdingForEscalation(e, state),
      raisedAt: e.createdAt,
    });
  }

  // Agents the account's usage limit stopped. Keyed on the agent id, which is
  // also what the row's control resumes — there is no escalation underneath one
  // of these, because there is no question in it to answer.
  for (const agentId of state.parkedOnLimit) {
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) continue;
    const originRef = state.tasks.find((t) => t.id === agent.taskId)?.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: agentId,
      kind: 'limit',
      group: 'blocking',
      title: agent.waitingReason ?? 'Parked: this account has no usage allowance left right now.',
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId,
      holding: 0,
      // The park has no row of its own to be stamped, so the agent's own clock is
      // the honest reading: it is the last thing that happened to it.
      raisedAt: agent.startedAt,
    });
  }

  for (const t of (state.humanTasks ?? []).filter((x) => x.status === 'open')) {
    const goalRef = goalOf(t.originRef, state);
    rows.push({
      id: t.id,
      kind: needKindOfTask(t.kind),
      group: 'yours',
      title: t.title,
      goalRef,
      originRef: t.originRef ?? null,
      opens: opensAt(goalRef, state),
      // A burn notice is *about* its agent — the run is the subject, and the rail
      // draws the id beside the row. Every other human task's `agentId` is the
      // agent that happened to ask, which is not what this field means, so it
      // stays null there rather than putting a bystander's id on the row.
      agentId: t.kind === 'burn' ? t.agentId : null,
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
