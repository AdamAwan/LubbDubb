import type { GoalIntake } from './intake/sitting.js';
import type {
  Agent,
  Decision,
  Issue,
  IssueAppraisal,
  IssueConclusion,
  IssueDelivery,
  IssueRun,
  IssueShortfall,
  Job,
  Plan,
  PlanPart,
  PullRequest,
  TaskSummary,
  WorldEvent,
  WorldSnapshot,
} from './types.js';
import { isPrWatched } from './pr/prHealth.js';
import { isSomeoneElsesPr } from './pr/prOwnership.js';
import { retainedRunIssues } from './floor/runs.js';

// → docs/spec/04-harness-cycle.md

export interface CycleReadings {
  tasks: TaskSummary[];
  agents: Agent[];
  queuedJobs: Job[];
  plans: Plan[];
  planParts: PlanPart[];
  conclusions: IssueConclusion[];
  deliveries: IssueDelivery[];
  deliverySignals: WorldEvent[];
  shortfalls: IssueShortfall[];
  appraisals: IssueAppraisal[];
  retrospectiveOrigins: string[];
  recentDecisions: Decision[];
  intake: GoalIntake;
  liveAgents: number;
  headroom: number;
}

export function dispatchView(
  world: WorldSnapshot,
  label: string,
  issueRuns: IssueRun[],
): { hiddenPrs: PullRequest[]; retainedIssues: Issue[]; dispatchWorld: WorldSnapshot } {
  const actedOn = (pr: PullRequest): boolean => isPrWatched(pr, label) && !isSomeoneElsesPr(pr);
  const hiddenPrs = world.pullRequests.filter((pr) => !actedOn(pr));
  const retainedIssues = retainedRunIssues(issueRuns, world.issues);
  const dispatchWorld: WorldSnapshot =
    hiddenPrs.length > 0 || retainedIssues.length > 0
      ? {
          ...world,
          pullRequests: world.pullRequests.filter(actedOn),
          issues: [...world.issues, ...retainedIssues],
        }
      : world;
  return { hiddenPrs, retainedIssues, dispatchWorld };
}
