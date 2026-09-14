import type { Store } from '../store/store.js';
import { rejectionSignalQuery } from '../proposals/proposals.js';
import type { DispatchContext } from './dispatcher.js';

// → docs/spec/05-dispatcher.md

const PRIOR_REMEDY_ROWS = 40;

type PulseReadings = Pick<
  DispatchContext,
  | 'world'
  | 'hiddenPrs'
  | 'retainedIssues'
  | 'tasks'
  | 'agents'
  | 'queuedJobs'
  | 'plans'
  | 'planParts'
  | 'conclusions'
  | 'deliveries'
  | 'deliverySignals'
  | 'shortfalls'
  | 'appraisals'
  | 'retrospectiveOrigins'
  | 'recentDecisions'
  | 'prReviews'
  | 'prReviewRoutes'
  | 'featureStandings'
  | 'remoteRuns'
  | 'modelPins'
  | 'agentHeadroom'
>;

export function buildDispatchInputs(store: Store, pulse: PulseReadings): DispatchContext {
  const proposals = store.escalations.listProposals();
  const signals = rejectionSignalQuery(proposals);
  const featureStandings = pulse.featureStandings ?? [];
  return {
    ...pulse,
    openEscalations: store.escalations.listOpenEscalations(),
    standingJobs: store.jobs.listStandingJobs(),
    ejections: store.ejections.liveEjections(),
    planAtoms: store.plans.listAllPlanAtoms(),
    planAmendments: store.plans.listPendingPlanAmendments(),
    validationChecks: store.validation.listAllValidationChecks(),
    validationPlans: store.validation.listValidationPlanRecords(),
    localRun: store.localRuns.liveLocalRun(),
    localValidations: [
      ...store.localValidations.listOpenLocalValidations(),
      ...store.localValidations.listLocalValidationsAwaitingFix(),
    ],
    selectorOfferings: store.remoteValidation.listSelectorOfferings(),
    featureSummaryKeys:
      featureStandings.length === 0
        ? []
        : store.tickets.listFeatureSummaries().map((f) => ({ originRef: f.originRef, standingKey: f.standingKey })),
    featureSequences: store.sequences.listFeatureSequences(),
    proposals,
    rejectionSignals: signals ? store.world.listWorldEventsSince(signals.since, signals.refs) : [],
    priorityOverrides: store.priority.listPriorityOverrides(),
    goalPriorities: store.priority.listGoalPriorities(),
    goalPauses: store.pauses.listGoalPauses(),
    profileOverrides: store.profileOverrides.listProfileOverrides(),
    priorRemedies: [
      ...store.remedies.listRecentRemedies('ci', PRIOR_REMEDY_ROWS),
      ...store.remedies.listRecentRemedies('review', PRIOR_REMEDY_ROWS),
    ],
    prSplits: store.prSplits.listPrSplitVerdicts(),
    prReviewedElsewhere: store.prReviewExternals.prsReviewedElsewhere(),
    obstacles: store.obstacles.obstacleBoard(),
    obstacleBlocks: store.obstacles.listObstacleBlocks(),
  };
}
