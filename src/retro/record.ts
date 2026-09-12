import type { Store } from '../store/store.js';
import type { Action, Escalation } from '../types.js';
import type { RetroDossierInput } from './dossier.js';

// → docs/spec/05-dispatcher.md

export function goalRecord(store: Store, issueOriginRef: string): RetroDossierInput {
  const issueNumber = Number(issueOriginRef.slice('issue:'.length));
  const world = store.world.getWorldBaseline();
  const issue = world?.issues.find((i) => i.number === issueNumber) ?? null;
  const plan = store.plans.getPlanByOrigin(issueOriginRef);
  const parts = plan ? store.plans.listPlanParts(plan.id) : [];
  const prNumbers = new Set<number>(parts.flatMap((p) => (p.prNumber === null ? [] : [p.prNumber])));
  if (issue?.linkedPrNumber) prNumbers.add(issue.linkedPrNumber);
  const mine = (ref: string | null | undefined): boolean =>
    ref === issueOriginRef || (ref?.startsWith(`${issueOriginRef}:`) ?? false);
  const tasks = store.tasks.listTasks().filter((t) => mine(t.originRef));
  const taskIds = new Set(tasks.map((t) => t.id));
  const agents = store.agents.listAgents().filter((a) => taskIds.has(a.taskId));

  return {
    issueNumber,
    issueTitle: issue?.title ?? issueOriginRef,
    plan,
    parts,
    pullRequests: (world?.pullRequests ?? []).filter((pr) => prNumbers.has(pr.number)),
    closedPullRequests: (world?.closedPullRequests ?? []).filter((pr) => prNumbers.has(pr.number)),
    decisions: store.decisions
      .listDecisionsForGoal(issueOriginRef)
      .filter((d) => mine(actionOrigin(d.action)))
      .reverse(),
    escalations: store.escalations
      .listEscalations()
      .filter((e) => (e.taskId ? taskIds.has(e.taskId) : mine(escalationOrigin(e))))
      .reverse(),
    proposals: store.escalations
      .listProposals()
      .filter((p) => mine(p.ref))
      .reverse(),
    agentCount: agents.length,
    delivery: store.verdicts.getDelivery(issueOriginRef),
    shortfall: store.verdicts.getShortfall(issueOriginRef),
    appraisal: store.verdicts.getAppraisal(issueOriginRef),
    conclusion: store.verdicts.getIssueConclusion(issueOriginRef),
    costUsd: agents.some((a) => a.costUsd !== null) ? agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) : null,
  };
}

function actionOrigin(action: Action): string | null {
  const ref = (action as { originRef?: unknown }).originRef;
  return typeof ref === 'string' ? ref : null;
}

function escalationOrigin(escalation: Escalation): string | null {
  const ref = escalation.context.originRef;
  return typeof ref === 'string' ? ref : null;
}
