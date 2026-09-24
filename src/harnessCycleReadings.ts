import type { RuntimeControl } from './runtimeControl.js';
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
import { deliverySignalQuery } from './delivery/delivery.js';
import { isPrWatched } from './pr/prHealth.js';
import { isSomeoneElsesPr } from './pr/prOwnership.js';
import { retainedRunIssues } from './floor/runs.js';
import { runPulse, type PulseDeps, type PulsePhase } from './pulseDesks.js';

// → docs/spec/04-harness-cycle.md

type ReadingDeps = PulseDeps & { runtime: RuntimeControl; goalIntake?: () => GoalIntake };

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

export async function readCycle(
  deps: ReadingDeps,
  world: WorldSnapshot,
  readWorld: boolean,
  mark: (phase: PulsePhase) => (pass: string | null) => void,
): Promise<CycleReadings> {
  const { store } = deps;
  await runPulse('open', deps, {}, readWorld, mark('open'));
  const tasks = store.tasks.listTasks();
  await runPulse('afterTasks', deps, { world, tasks }, readWorld, mark('afterTasks'));
  const agents = store.agents.listAgents();
  await runPulse('afterAgents', deps, { tasks, agents }, readWorld, mark('afterAgents'));
  const queuedJobs = store.jobs.listQueuedJobs();
  const plans = store.plans.listPlans();
  const planParts = store.plans.listAllPlanParts();
  const conclusions = store.verdicts.listIssueConclusions();
  const deliveries = store.verdicts.listDeliveries();
  const deliveryWindow = deliverySignalQuery(deliveries);
  const shortfalls = store.verdicts.listShortfalls();
  const deliverySignals = deliveryWindow
    ? store.world.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs)
    : [];
  const appraisals = store.verdicts.listAppraisals();
  await runPulse('afterVerdicts', deps, { world }, readWorld, mark('afterVerdicts'));
  const retrospectiveOrigins = store.scratch.listRetrospectiveOrigins();
  await runPulse(
    'afterOrigins',
    deps,
    { world, tasks, signals: { retrospectiveOrigins, conclusions, deliveries, shortfalls, plans, planParts } },
    readWorld,
    mark('afterOrigins'),
  );
  const recentDecisions = store.decisions.listDecisions(200);
  const intake = deps.goalIntake?.() ?? { closedSittings: null, criteria: [], judgeOwed: [] };
  const liveAgents = store.agents.countLiveAgents();
  const headroom = deps.runtime.paused ? 0 : Math.max(0, deps.runtime.cap - liveAgents);
  return {
    tasks,
    agents,
    queuedJobs,
    plans,
    planParts,
    conclusions,
    deliveries,
    deliverySignals,
    shortfalls,
    appraisals,
    retrospectiveOrigins,
    recentDecisions,
    intake,
    liveAgents,
    headroom,
  };
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
