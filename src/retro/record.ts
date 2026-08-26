import type { Store } from '../store/store.js';
import type { Action, Escalation } from '../types.js';
import type { RetroDossierInput } from './dossier.js';

/**
 * Everything the harness kept about one goal, read out of the store in the one
 * shape anything that has to account for a run needs.
 *
 * **There is one assembly of this and there must stay one.** Two readers want it
 * for different reasons — a retrospective agent writing the run up
 * (`src/executor/actionExecutor.ts`) and the operator's own Claude Code answering
 * a question about it (`goal_read`, `src/mcp/desktopTools.ts`) — and the
 * temptation is a second gather beside the first, because each wants a different
 * *rendering*. What that would actually produce is two answers to "what happened
 * on this goal" that are free to disagree: the subtree predicate, the escalation
 * matching and the four goal-scoped reads below are each a decision, and a copy
 * of them is a copy that stops tracking the original silently. The rendering is
 * the caller's; the reading is here.
 *
 * → `docs/spec/11-mcp-tools.md#the-desktop-channel`
 */
export function goalRecord(store: Store, issueOriginRef: string): RetroDossierInput {
  const issueNumber = Number(issueOriginRef.slice('issue:'.length));
  const world = store.getWorldBaseline();
  const issue = world?.issues.find((i) => i.number === issueNumber) ?? null;
  const plan = store.getPlanByOrigin(issueOriginRef);
  const parts = plan ? store.listPlanParts(plan.id) : [];
  const prNumbers = new Set<number>(parts.flatMap((p) => (p.prNumber === null ? [] : [p.prNumber])));
  if (issue?.linkedPrNumber) prNumbers.add(issue.linkedPrNumber);
  // The issue's own subtree — the predicate every gate in the dispatcher keys on.
  const mine = (ref: string | null | undefined): boolean =>
    ref === issueOriginRef || (ref?.startsWith(`${issueOriginRef}:`) ?? false);
  const tasks = store.listTasks().filter((t) => mine(t.originRef));
  const taskIds = new Set(tasks.map((t) => t.id));
  const agents = store.listAgents().filter((a) => taskIds.has(a.taskId));

  return {
    issueNumber,
    issueTitle: issue?.title ?? issueOriginRef,
    plan,
    parts,
    pullRequests: (world?.pullRequests ?? []).filter((pr) => prNumbers.has(pr.number)),
    closedPullRequests: (world?.closedPullRequests ?? []).filter((pr) => prNumbers.has(pr.number)),
    // Every list oldest-first, which is the order `retroDossier` states for its
    // decisions and needs for all four: its caps keep the *tail*, so a newest-first
    // list handed over unreversed kept the earliest rows and said it had dropped
    // them. The goal-scoped reads are what make the dossier's own named constants
    // the only cap — `listDecisions`/`listFacts` cut fleet-wide at 200 before any
    // filter here could run. → docs/spec/05-dispatcher.md#what-it-is-bounded-by
    decisions: store
      .listDecisionsForGoal(issueOriginRef)
      .filter((d) => mine(actionOrigin(d.action)))
      .reverse(),
    // Matched on its task **or** its own origin: an agent's escalation carries no
    // `originRef` of its own, and the harness's carries no task. Selecting on the
    // task alone dropped every ask the harness put to the operator about the goal.
    escalations: store
      .listEscalations()
      .filter((e) => (e.taskId ? taskIds.has(e.taskId) : mine(escalationOrigin(e))))
      .reverse(),
    proposals: store
      .listProposals()
      .filter((p) => mine(p.ref))
      .reverse(),
    claims: store
      .listFactsForGoal(issueOriginRef)
      .filter((f) => mine(f.originRef))
      .reverse(),
    agentCount: agents.length,
    delivery: store.getDelivery(issueOriginRef),
    shortfall: store.getShortfall(issueOriginRef),
    appraisal: store.getAppraisal(issueOriginRef),
    conclusion: store.getIssueConclusion(issueOriginRef),
    // Null rather than 0 when nothing was reported: PTY mode reports no usage at
    // all, and a confident "$0.00" is the one reading that would be a lie.
    costUsd: agents.some((a) => a.costUsd !== null) ? agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) : null,
  };
}

function actionOrigin(action: Action): string | null {
  const ref = (action as { originRef?: unknown }).originRef;
  return typeof ref === 'string' ? ref : null;
}

/**
 * Which goal an escalation is about, when it carries no task to be asked through.
 *
 * A narrowing rather than a parse, in {@link actionOrigin}'s shape and beside it so
 * the two readings of "which goal is this row about" stay together. It exists
 * because the harness raises escalations of its own — the plan approval and the
 * shortfall ask — with no `taskId` at all, and those are the two most consequential
 * human decisions a goal ever produces.
 */
function escalationOrigin(escalation: Escalation): string | null {
  const ref = escalation.context.originRef;
  return typeof ref === 'string' ? ref : null;
}
