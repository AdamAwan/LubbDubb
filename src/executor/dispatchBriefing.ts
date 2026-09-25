import type { IssueOriginFamily } from '../issueOrigins.js';
import { inIssueOriginFamily, issueOriginRef, parseIssueOrigin } from '../issueOrigins.js';
import type { Store } from '../store/store.js';
import type { ValidatedAction } from '../dispatcher/actions.js';
import { rejectionGuidance } from '../proposals/proposals.js';
import { outstandingWorkNote } from '../mcp/conclusion.js';
import { operatorInstructionsNote } from '../goalInstructions.js';
import { attachmentsNote } from '../jobs/attachments.js';
import { retroSubmitOrigin } from '../retro/retro.js';
import { retroDossier, retroPad } from '../retro/dossier.js';
import { goalRecord } from '../retro/record.js';
import { featureSummarySubmitOrigin } from '../featureSummaries/featureSummary.js';
import { featureRecords, featureReach, renderFeatureDossier } from '../featureSummaries/featureRecord.js';
import type { FeatureBoardFacts } from '../featureSummaries/featureRecord.js';
import { sequenceBriefing } from '../sequence/dossier.js';
import { featureSequenceSubmitOrigin } from '../sequence/sequence.js';
import { neighbourSeedPaths, priorWorkBriefing } from '../briefing/priorWork.js';
import { deliveredWorkBriefing } from '../briefing/delivered.js';
import { assessIssueNumber } from '../delivery/assessment.js';
import { issueForPr } from '../pr/prIssue.js';
import { liveParts } from '../plans/parts.js';
import { goalOriginFor } from '../scratch/pad.js';
import { dispatchFactScopes } from '../knowledge/block.js';
import { corroborationGoal } from '../knowledge/knowledge.js';
import { obstaclesForDispatch, renderObstacleNote } from '../obstacles/delivery.js';
import { retryNote, type RetryResume } from './retryResume.js';
import { handoverNote, type HandoverResume } from './handoverResume.js';
import { ciEvidenceNote, type CiEvidenceReader, type CiEvidenceTarget } from '../ci/ciEvidence.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { FeatureSequence, PullRequest } from '../types.js';

// → docs/spec/09-execution.md

export type DispatchAction = ValidatedAction & { type: 'dispatch_code_agent' | 'dispatch_desk_agent' };

interface EvidenceDeps {
  store: Store;
  errors: ErrorRecorder;
  ciEvidence?: CiEvidenceReader;
}

interface BriefingDeps {
  store: Store;
  instructionTracker?: (issueNumber: number) => string | null;
  featureBoard?: () => FeatureBoardFacts | null;
}

export async function ciEvidenceFor(
  deps: EvidenceDeps,
  action: ValidatedAction & { type: 'dispatch_code_agent' },
): Promise<string> {
  const reader = deps.ciEvidence;
  if (!reader || action.rule !== 'pr-ci-failing') return '';
  const names = action.ciChecks ?? [];
  if (names.length === 0) return '';
  const prNumber = Number(/^pr:(\d+):/.exec(action.originRef ?? '')?.[1]);
  if (!Number.isInteger(prNumber)) return '';

  const pr = deps.store.world.getWorldBaseline()?.pullRequests.find((p) => p.number === prNumber);
  const targets: CiEvidenceTarget[] = (pr?.ciChecks ?? [])
    .filter((c) => c.evidenceRef !== undefined && names.includes(c.name))
    .map((c) => ({ name: c.name, evidenceRef: c.evidenceRef! }));
  if (targets.length === 0) return '';

  try {
    return ciEvidenceNote(await reader.readCiFailureEvidence(prNumber, targets));
  } catch (err) {
    deps.errors.record({
      source: 'provider',
      message: `Could not read CI evidence for PR #${prNumber}: ${(err as Error).message}`,
      detail: 'The CI-fix agent was dispatched without it.',
    });
    return '';
  }
}

export function dispatchPrompt(
  deps: BriefingDeps,
  action: DispatchAction,
  evidence: string,
  retry: RetryResume | null,
  handover: HandoverResume | null,
): string {
  const { store } = deps;
  const origin = action.originRef;
  const guidance = rejectionGuidance(
    [origin, ...(action.type === 'dispatch_code_agent' ? (action.signalRefs ?? []) : [])],
    store.escalations.listProposals(),
  );
  const outstanding = outstandingForOrigin(origin, store);
  const prior = priorWorkFor(origin, store, outstanding !== null);
  const delivered = deliveredWorkFor(origin, store);
  const briefing = retroBriefing(origin, store);
  const feature = featureBriefing(origin, store, deps.featureBoard?.() ?? undefined);
  const sequence = sequenceBriefing(
    origin,
    store.world.getWorldBaseline()?.issues ?? [],
    sequenceFeatureOrigin(origin, store),
  );
  const attachments = attachmentsFor(origin, store);
  const note = retry
    ? retryNote(retry.priorAttempts + 1, action.type === 'dispatch_code_agent')
    : handover
      ? handoverNote()
      : null;
  const instructions = instructionsFor(origin, store, deps.instructionTracker);
  const obstacles = obstaclesFor(action, store);
  return [
    note,
    action.prompt,
    instructions,
    evidence,
    obstacles,
    guidance,
    outstanding,
    prior,
    delivered,
    briefing,
    feature,
    sequence,
    attachments,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function attachmentsFor(originRef: string | null | undefined, store: Store): string | null {
  if (!originRef) return null;
  return attachmentsNote(store.jobs.listAttachments(goalOriginFor(originRef) ?? originRef)) || null;
}

function obstaclesFor(action: DispatchAction, store: Store): string | null {
  const scopes = dispatchFactScopes(
    action.originRef ?? null,
    action.type === 'dispatch_code_agent' ? (action.ciChecks ?? null) : null,
  );
  const goal = corroborationGoal(action.originRef ?? null);
  const paths = goal === null ? [] : store.agents.listGoalFiles(goal).map((file) => file.path);
  if (scopes.length === 0 && paths.length === 0) return null;
  const rows = store.obstacles
    .listObstacles()
    .map((obstacle) => ({ obstacle, keys: store.obstacles.listObstacleKeys(obstacle.id) }));
  return renderObstacleNote(obstaclesForDispatch({ rows, scopes, paths })) || null;
}

function instructionsFor(
  originRef: string | null | undefined,
  store: Store,
  tracker: ((issueNumber: number) => string | null) | undefined,
): string | null {
  const goal = goalOriginFor(originRef ?? null);
  if (!goal) return null;
  const standing = store.instructions.listStandingInstructions(goal);
  if (standing.length === 0) return null;
  const number = Number(goal.slice('issue:'.length));
  return operatorInstructionsNote(standing, tracker?.(number) ?? null) || null;
}

function outstandingForOrigin(originRef: string | null | undefined, store: Store): string | null {
  if (!originRef) return null;
  const stored = store.verdicts.getIssueConclusion(originRef);
  if (!stored || stored.verdict !== 'more_work' || stored.by !== 'agent') return null;
  return outstandingWorkNote(stored.note, stored.updatedAt);
}

const WITHOUT_PRIOR_WORK: ReadonlySet<IssueOriginFamily> = new Set<IssueOriginFamily>([
  'retro',
  'split',
  'summary',
  'sequence',
]);

function priorWorkFor(originRef: string | null | undefined, store: Store, outstandingShown: boolean): string | null {
  const ref = originRef ?? '';
  const issueOriginRef = goalOriginFor(ref);
  if (!issueOriginRef) return null;
  const parsed = parseIssueOrigin(ref);
  if (parsed !== null && WITHOUT_PRIOR_WORK.has(parsed.family)) return null;
  const plan = store.plans.getPlanByOrigin(issueOriginRef);
  const files = store.agents.listGoalFiles(issueOriginRef);
  const briefing = priorWorkBriefing({
    plan,
    caveatAnswers: plan ? store.plans.listPlanCaveatAnswers(plan.id) : [],
    parts: plan ? store.plans.listPlanParts(plan.id) : [],
    appraisal: store.verdicts.getAppraisal(issueOriginRef),
    conclusion: outstandingShown ? null : store.verdicts.getIssueConclusion(issueOriginRef),
    delivery: store.verdicts.getDelivery(issueOriginRef),
    shortfall: store.verdicts.getShortfall(issueOriginRef),
    entries: store.scratch.listScratchEntries(issueOriginRef),
    files,
    neighbours: store.agents.listGoalNeighbours(issueOriginRef, neighbourSeedPaths(files, plan)),
    forPart: inIssueOriginFamily('part', ref),
  });
  return briefing || null;
}

function deliveredWorkFor(originRef: string | null | undefined, store: Store): string | null {
  const issueNumber = assessIssueNumber(originRef ?? '');
  if (issueNumber === null) return null;
  const baseline = store.world.getWorldBaseline();
  const plan = store.plans.getPlanByOrigin(issueOriginRef('root', issueNumber));
  const partPrs = new Set(
    (plan ? liveParts(store.plans.listPlanParts(plan.id)) : []).flatMap((p) =>
      p.prNumber === null ? [] : [p.prNumber],
    ),
  );
  const byNumber = new Map<number, PullRequest>();
  for (const pr of store.prArchive.listArchivedPrs()) byNumber.set(pr.number, pr);
  for (const pr of baseline?.closedPullRequests ?? []) byNumber.set(pr.number, pr);
  const issues = baseline?.issues ?? [];
  const prs = [...byNumber.values()]
    .filter((pr) => partPrs.has(pr.number) || issueForPr(pr, issues)?.number === issueNumber)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || b.number - a.number);
  return deliveredWorkBriefing(prs) || null;
}

function featureBriefing(
  originRef: string | null | undefined,
  store: Store,
  board: FeatureBoardFacts | undefined,
): string | null {
  const target = originRef ? featureSummarySubmitOrigin(originRef) : { ok: false as const, error: '' };
  if (!target.ok || !board) return null;
  const record = featureRecords(store, board).find((f) => f.number === target.featureNumber);
  if (!record) return null;
  const previous = store.tickets.getFeatureSummary(target.featureOrigin);
  return renderFeatureDossier(
    record,
    featureReach(store, board),
    previous
      ? [
          `**Where this is:** ${previous.standing}`,
          previous.usable ? `**Usable now:** ${previous.usable}` : null,
          previous.blocked ? `**Blocked:** ${previous.blocked}` : null,
          previous.remaining ? `**Left to do:** ${previous.remaining}` : null,
        ]
          .filter(Boolean)
          .join('\n\n')
      : null,
  );
}

function retroBriefing(originRef: string | null | undefined, store: Store): string | null {
  const target = originRef ? retroSubmitOrigin(originRef) : { ok: false as const, error: '' };
  if (!target.ok) return null;
  const issueOriginRef = target.issueOrigin;
  const dossier = retroDossier(goalRecord(store, issueOriginRef));
  return [retroPad(store.scratch.listScratchEntries(issueOriginRef)), dossier].filter(Boolean).join('\n\n');
}

function sequenceFeatureOrigin(originRef: string | null | undefined, store: Store): FeatureSequence | null {
  const target = originRef ? featureSequenceSubmitOrigin(originRef) : { ok: false as const, error: '' };
  return target.ok ? store.sequences.getFeatureSequence(target.featureOrigin) : null;
}
