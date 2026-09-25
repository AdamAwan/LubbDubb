import type {
  Issue,
  LocalRun,
  LocalValidation,
  LocalRunReadings,
  LocalRunTurn,
  PlanPart,
  TaskSummary,
} from '../types.js';
import type { Store } from '../store/store.js';
import type {
  LocalRunRefFacts,
  LocalRunTargetView,
  LocalRunView,
  LocalValidationAgentView,
  LocalValidationPhase,
  LocalValidationView,
  PullRequest,
} from '../wire.js';
import { prState } from '../pr/prHealth.js';
import { openPrForIssue } from '../dispatcher/issuePickup.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { localRunIsLive } from '../store/localRuns.js';
import { localRunChoices } from '../localRun/ref.js';
import { isActiveTask } from '../tasks.js';

// → docs/spec/16-http-api.md

export function localRunView(
  run: LocalRun | null,
  runner: { phase(): string | null; turn(): LocalRunTurn | null; holdsSession(): boolean },
  readings: LocalRunReadings,
  facts: (ref: string, origin: string) => LocalRunRefFacts,
): LocalRunView | null {
  if (run === null) return null;
  const live = localRunIsLive(run);
  return {
    ...run,
    live,
    phase: runner.phase(),
    turn: runner.turn(),
    holdsSession: runner.holdsSession(),
    ports: live ? readings.ports : null,
    freshness: live ? readings.freshness : null,
    refFacts: facts(run.ref, run.originRef),
  };
}

export function localRunRefFacts(
  ref: string,
  parts: readonly PlanPart[],
  ctx: { prByBranch: Map<string, PullRequest>; tasks: readonly TaskSummary[]; defaultBranch: string },
): LocalRunRefFacts {
  const part = parts.find((p) => p.branch === ref) ?? null;
  const pr = ctx.prByBranch.get(ref) ?? null;
  const onBranch = ctx.tasks.filter((t) => t.branch === ref);
  return {
    ref,
    isDefaultBranch: ref === ctx.defaultBranch,
    part:
      part === null
        ? null
        : { slug: part.slug, title: part.title, seq: part.seq, total: parts.length, status: part.status },
    pr:
      pr === null
        ? null
        : {
            number: pr.number,
            state: prState(pr),
            ciStatus: pr.ciStatus,
            failing: [...(pr.ciVerdict?.dispatch ?? []), ...(pr.ciVerdict?.escalate ?? [])].map((c) => c.name),
            approved: pr.approved === true,
            unresolved: pr.unresolvedComments.length,
          },
    mergedParts: parts.filter((p) => p.status === 'merged').length,
    agentOnIt: onBranch.some((t) => isActiveTask(t)),
    lastActivityAt: onBranch.reduce<string | null>(
      (newest, t) => (newest === null || t.updatedAt > newest ? t.updatedAt : newest),
      null,
    ),
  };
}

export function localRunTargetViews(ctx: {
  issues: readonly Issue[];
  partsOf: (origin: string) => PlanPart[];
  prByBranch: Map<string, PullRequest>;
  openPrs: PullRequest[];
  tasks: readonly TaskSummary[];
  defaultBranch: string;
}): LocalRunTargetView[] {
  return ctx.issues.map((issue) => {
    const origin = issueConclusionOrigin(issue.number);
    const parts = ctx.partsOf(origin);
    const choices = localRunChoices(parts, openPrForIssue(issue, ctx.openPrs)?.branch ?? null);
    const facts = (ref: string): LocalRunRefFacts => localRunRefFacts(ref, parts, ctx);
    return {
      originRef: origin,
      issueNumber: issue.number,
      target: facts(choices.target ?? ctx.defaultBranch),
      options: choices.options.map((option) => ({ option, facts: facts(option.ref) })),
      runnable: choices.target !== null,
    };
  });
}

export function localValidationView(
  row: LocalValidation | undefined,
  live: LocalRun | null,
  store: Store,
  signer?: (id: string, name: string) => string,
): LocalValidationView | null {
  if (row === undefined) return null;
  const agentOf = (taskId: string | null): LocalValidationAgentView | null => {
    if (taskId === null) return null;
    const task = store.tasks.getTask(taskId);
    if (!task?.agentId) return null;
    const agent = store.agents.getAgent(task.agentId);
    return agent ? { id: agent.id, status: agent.status } : null;
  };
  return {
    ...row,
    phase: localValidationPhase(row, live),
    files: row.screenshots.map((name: string) => {
      const base = `/local-validations/${encodeURIComponent(row.id)}/files/${encodeURIComponent(name)}`;
      return { name, url: signer ? `${base}?tk=${encodeURIComponent(signer(row.id, name))}` : base };
    }),
    agent: agentOf(row.taskId),
    fixAgent: agentOf(row.fixTaskId),
  };
}

function localValidationPhase(row: LocalValidation, live: LocalRun | null): LocalValidationPhase | null {
  if (row.status === 'pending') return 'queued';
  if (row.status !== 'dispatched') return null;
  if (row.plan === null) return 'planning';
  return live?.status === 'running' ? 'driving' : 'environment';
}
