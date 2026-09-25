import type {
  IssueConclusion,
  IssueConclusionVerdict,
  ObstacleBlock,
  PartOutcomeKind,
  PlanPart,
  ShortfallCause,
  Task,
} from '../types.js';
import type { Store } from '../store/store.js';
import { conclusionOrigin } from '../issueConclusion.js';
import { assessmentOrigin, type AssessmentVerdict } from '../mcp/assessment.js';
import { appraiserOrigin, type GoalAppraisalVerdictName } from '../mcp/goalAppraisal.js';
import { plannerOrigin } from '../mcp/planNotNeeded.js';
import { goalFingerprint } from '../intake/appraisal.js';
import { partConclusionOrigin } from '../mcp/partOutcome.js';
import { issueOrigin } from '../plans/planning.js';
import { liveParts } from '../plans/parts.js';
import type { AgentEmitter, AgentManagerOptions } from './agentContract.js';

// → docs/spec/11-mcp-tools.md

export interface VerdictContext {
  store: Store;
  opts: AgentManagerOptions;
  events: AgentEmitter;
}

export function recordConclusion(
  ctx: VerdictContext,
  agentId: string,
  task: Task,
  verdict: IssueConclusionVerdict,
  note: string,
): { ok: true; conclusion: IssueConclusion } | { ok: false; error: string } {
  const origin = conclusionOrigin(task.originRef);
  if (!origin.ok) return { ok: false, error: origin.error };
  const conclusion = ctx.store.verdicts.recordIssueConclusion({
    originRef: origin.originRef,
    verdict,
    note,
    by: 'agent',
    agentId,
    taskId: task.id,
  });
  ctx.store.instructions.settleInstructions(origin.originRef);
  ctx.events.emit('conclusion', { agentId, taskId: task.id, conclusion });
  return { ok: true, conclusion };
}

export function recordBlocked(
  ctx: VerdictContext,
  agentId: string,
  task: Task,
  obstacleId: string,
  note: string,
): { ok: true; block: ObstacleBlock } | { ok: false; error: string } {
  const origin = conclusionOrigin(task.originRef);
  if (!origin.ok) return { ok: false, error: origin.error };
  const obstacle = ctx.store.obstacles.getObstacle(obstacleId);
  if (!obstacle) {
    return {
      ok: false,
      error:
        `No obstacle has that id (${obstacleId}), so nothing was recorded and your goal is not parked. ` +
        `Name the id raise answered with — and if you have not raised what stopped you, raise it first: ` +
        `a block that names nothing is a goal nothing brings back.`,
    };
  }
  const block = ctx.store.obstacles.recordObstacleBlock({
    originRef: origin.originRef,
    obstacleId,
    agentId,
    taskId: task.id,
    note,
  });
  ctx.store.instructions.settleInstructions(origin.originRef);
  return { ok: true, block };
}

export function recordAssessment(
  ctx: VerdictContext,
  agentId: string,
  task: Task,
  verdict: AssessmentVerdict,
  summary: string,
  detail: string | null,
  cause: ShortfallCause | null,
  part: string | null,
): { ok: true; issueOrigin: string; verdict: AssessmentVerdict } | { ok: false; error: string } {
  const origin = assessmentOrigin(task.originRef);
  if (!origin.ok) return { ok: false, error: origin.error };

  if (verdict === 'delivered') {
    ctx.store.verdicts.recordDelivery({
      originRef: origin.issueOrigin,
      summary,
      detail,
      by: 'assessor',
      agentId,
      taskId: task.id,
    });
    ctx.events.emit('assessment', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
    return { ok: true, issueOrigin: origin.issueOrigin, verdict };
  }

  const plan = ctx.store.plans.listPlans().find((p) => p.originRef === origin.issueOrigin) ?? null;
  const parts = plan ? liveParts(ctx.store.plans.listPlanParts(plan.id)) : [];

  if (plan === null && (cause === 'plan' || cause === 'part')) {
    return {
      ok: false,
      error:
        `cause "${cause}" says the delivery plan is what fell short, and ${origin.issueOrigin} has no plan — ` +
        `there is nothing to re-plan and no part to follow up. If the issue's own goal is the problem, say ` +
        `cause "goal". If the work simply is not finished, say more_work with no cause: the issue comes ` +
        `back round for pickup with your summary against it.`,
    };
  }
  if (plan !== null && cause === null) {
    return {
      ok: false,
      error:
        `${origin.issueOrigin} has a delivery plan, so a shortfall has to say what fell short or the harness ` +
        `cannot route it: cause "plan" (the split itself is wrong, or a part is missing), "part" (one named ` +
        `part missed its own scope — name it in \`part\`), or "goal" (the issue itself is wrong, and no ` +
        `planner can fix that).`,
    };
  }
  if (cause === 'part' && !parts.some((p) => p.slug === part)) {
    return {
      ok: false,
      error:
        parts.length === 0
          ? `${origin.issueOrigin}'s plan declares no parts — it is a single-pull-request verdict, so there ` +
            `is no "${part}" to follow up. Say cause "plan" if one pull request was not enough; the planner ` +
            `will see your summary and may decompose it.`
          : `"${part}" is not a live part of ${origin.issueOrigin}'s plan. Its parts are: ` +
            `${parts.map((p) => p.slug).join(', ')}. Name one of those, or say cause "plan" if the part you ` +
            `have in mind is one the decomposition is missing.`,
    };
  }

  ctx.store.verdicts.recordShortfall({
    originRef: origin.issueOrigin,
    cause,
    partSlug: part,
    summary,
    detail,
    by: 'assessor',
    agentId,
    taskId: task.id,
  });
  ctx.events.emit('assessment', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
  return { ok: true, issueOrigin: origin.issueOrigin, verdict };
}

export function recordGoalMet(
  ctx: VerdictContext,
  agentId: string,
  task: Task,
  summary: string,
  detail: string,
): { ok: true; issueOrigin: string } | { ok: false; error: string } {
  const origin = plannerOrigin(task.originRef);
  if (!origin.ok) return { ok: false, error: origin.error };

  const plan = ctx.store.plans.getPlanByOrigin(origin.issueOrigin);
  if (plan) {
    return {
      ok: false,
      error:
        `${origin.issueOrigin} already has a delivery plan, so this is a replan and plan_not_needed ` +
        `cannot settle it: the plan would go on owning the issue, and any part already dispatched or ` +
        `in review would go on running underneath a goal marked delivered. Submit the amended plan ` +
        `with plan_submit — a part that turned out to be unnecessary is one you leave out, and one ` +
        `already in flight is a part whose agent closes it with conclude_part. If you believe the ` +
        `whole goal is already met, raise it: the operator asked for this replan and it is theirs to end.`,
    };
  }

  const shortfall = ctx.store.verdicts.getShortfall(origin.issueOrigin);
  if (shortfall) {
    return {
      ok: false,
      error:
        `An assessment of ${origin.issueOrigin} standing right now says the goal is *not* reached — ` +
        `"${shortfall.summary}" — and it was cast against the delivered state rather than against a ` +
        `plan. Recording a delivery here would erase it. Read what it says is missing; if it is wrong, ` +
        `raise that, and if it is right, plan the work it names.`,
    };
  }

  ctx.store.verdicts.recordDelivery({
    originRef: origin.issueOrigin,
    summary,
    detail,
    by: 'planner',
    agentId,
    taskId: task.id,
  });
  ctx.events.emit('goalMet', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin });
  return { ok: true, issueOrigin: origin.issueOrigin };
}

export function recordAppraisal(
  ctx: VerdictContext,
  agentId: string,
  task: Task,
  verdict: GoalAppraisalVerdictName,
  summary: string,
  profile: string | null,
  placement?: { missing?: string[]; parent: number | null; areaPath: string | null },
):
  | { ok: true; issueOrigin: string; verdict: GoalAppraisalVerdictName; profileHeld: boolean }
  | { ok: false; error: string } {
  const origin = appraiserOrigin(task.originRef);
  if (!origin.ok) return { ok: false, error: origin.error };

  const proposedProfile = ctx.opts.goalProfile && profile ? profile : null;
  const profileHeld =
    proposedProfile !== null && proposedProfile !== ctx.opts.goalProfile?.effective(origin.issueOrigin);
  ctx.store.verdicts.recordAppraisal({
    originRef: origin.issueOrigin,
    verdict,
    summary,
    missing: placement?.missing ?? [],
    goalRef: goalFingerprint(task.originTitle, task.originSummary),
    by: 'appraiser',
    proposedProfile,
    profileDiverges: profileHeld,
    proposedParent: placement?.parent ?? null,
    proposedAreaPath: placement?.areaPath ?? null,
    agentId,
    taskId: task.id,
  });
  ctx.events.emit('appraisal', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
  return { ok: true, issueOrigin: origin.issueOrigin, verdict, profileHeld };
}

export function recordPartOutcome(
  ctx: VerdictContext,
  agentId: string,
  task: Task,
  kind: PartOutcomeKind,
  summary: string,
  ref: string | null,
): { ok: true; part: PlanPart } | { ok: false; error: string } {
  const origin = partConclusionOrigin(task.originRef);
  if (!origin.ok) return { ok: false, error: origin.error };
  const plan = ctx.store.plans.getPlanByOrigin(issueOrigin(origin.issueNumber));
  const part = plan ? ctx.store.plans.listPlanParts(plan.id).find((p) => p.slug === origin.slug) : undefined;
  if (!part) {
    return { ok: false, error: `no part "${origin.slug}" is recorded for issue #${origin.issueNumber}.` };
  }
  const concluded = ctx.store.plans.concludePlanPart(part.id, { kind, ref, summary });
  if (!concluded) {
    return {
      ok: false,
      error:
        `part "${origin.slug}" is "${part.status}", and only a part being worked can be concluded. ` +
        `A merged part already finished; a retired one was dropped by a replan.`,
    };
  }
  ctx.events.emit('partOutcome', { agentId, taskId: task.id, part: concluded });
  return { ok: true, part: concluded };
}
