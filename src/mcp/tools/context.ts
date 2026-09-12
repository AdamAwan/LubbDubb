import type { Store } from '../../store/store.js';
import type { ErrorRecorder } from '../../errorLog.js';
import type { PermissionDesk } from '../../agents/permissionDesk.js';
import type {
  Agent,
  AgentAsk,
  HumanTask,
  HumanTaskInput,
  IssueConclusion,
  IssueConclusionVerdict,
  ObstacleBlock,
  PadDecision,
  PartOutcomeKind,
  PlanPart,
  Remedy,
  FeatureSequenceEdge,
  ScratchEntry,
  ShortfallCause,
  DecisionOutcome,
  Task,
  BugFiling,
} from '../../types.js';
import type { ActionSink } from '../../sink/actionSink.js';
import type { TicketFiler } from '../../tickets/filing.js';
import type { PromptTemplates } from '../../dispatcher/promptTemplates.js';
import type { WatchDryRunner } from '../../environments/watchDryRun.js';
import type { StateQueryDesk } from '../../remoteValidation/stateQueries.js';
import type { RemoteReadingDesk } from '../../remoteValidation/readings.js';
import type { PrRefStyle } from '../../prRef.js';
import type { AssessmentVerdict } from '../assessment.js';
import type { GoalAppraisalVerdictName } from '../goalAppraisal.js';
import type { AreaPathTree } from '../../intake/placement.js';
import type { RemedySubmission } from '../../remedies/remedies.js';
import type { FeatureSummaryInput } from '../../summaries/featureSummary.js';
import type { ReviewPackAuthor } from '../../reviewPacks/author.js';
import type { ReviewPackChecker } from '../../reviewPacks/checker.js';
import type { LocalValidationDesk } from '../../localValidation/desk.js';
import type { LocalRunner } from '../../localRun/runner.js';
import type { LocalRunWatch } from '../../localRun/watch.js';
import type { StepCapabilities } from '../../validation/steps.js';
import { issueOrigin, originIssueNumber } from '../../plans/planning.js';
import { type McpTool, toolJson, type ToolCallResult } from '../protocol.js';

// → docs/spec/11-mcp-tools.md

export interface AgentToolTarget {
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string };
  requestHumanTask(
    agentId: string,
    input: HumanTaskInput,
  ): { ok: true; task: HumanTask } | { ok: false; error: string };
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string };
  filingTarget(agentId: string): { ok: true; kind: 'bug'; storyNumber: number | null } | { ok: false; error: string };
  linkTicket(agentId: string, ticketRef: string): { ok: true; bug: BugFiling } | { ok: false; error: string };
  recordConclusion(
    agentId: string,
    verdict: IssueConclusionVerdict,
    note: string,
  ): { ok: true; conclusion: IssueConclusion } | { ok: false; error: string };
  recordBlocked(
    agentId: string,
    obstacleId: string,
    note: string,
  ): { ok: true; block: ObstacleBlock } | { ok: false; error: string };
  recordAssessment(
    agentId: string,
    verdict: AssessmentVerdict,
    summary: string,
    detail: string | null,
    cause: ShortfallCause | null,
    part: string | null,
  ): { ok: true; issueOrigin: string; verdict: AssessmentVerdict } | { ok: false; error: string };
  recordGoalMet(
    agentId: string,
    summary: string,
    detail: string,
  ): { ok: true; issueOrigin: string } | { ok: false; error: string };
  recordAppraisal(
    agentId: string,
    verdict: GoalAppraisalVerdictName,
    summary: string,
    profile: string | null,
    placement?: { missing?: string[]; parent: number | null; areaPath: string | null },
  ):
    | {
        ok: true;
        issueOrigin: string;
        verdict: GoalAppraisalVerdictName;
        profileHeld: boolean;
      }
    | { ok: false; error: string };
  recordPartOutcome(
    agentId: string,
    kind: PartOutcomeKind,
    summary: string,
    ref: string | null,
  ): { ok: true; part: PlanPart } | { ok: false; error: string };
  appendScratch(
    agentId: string,
    note: string,
    topic: string | null,
    decision: PadDecision | null,
  ): { ok: true; entry: ScratchEntry } | { ok: false; error: string };
  readScratch(agentId: string): { ok: true; padRef: string; entries: ScratchEntry[] } | { ok: false; error: string };
  recordFeatureSummary(
    agentId: string,
    input: FeatureSummaryInput,
  ): { ok: true; featureOrigin: string } | { ok: false; error: string };
  recordFeatureSequence(
    agentId: string,
    input: { reason: string; unsure: string | null; edges: FeatureSequenceEdge[] },
  ): { ok: true; featureOrigin: string; edges: number; carried: boolean } | { ok: false; error: string };
  recordRetrospective(
    agentId: string,
    summary: string,
    document: string,
  ): { ok: true; issueOrigin: string } | { ok: false; error: string };
  recordRemedy(
    agentId: string,
    submission: RemedySubmission,
  ): { ok: true; remedy: Remedy } | { ok: false; error: string };
}

export interface McpToolDeps {
  store: Store;
  agents: AgentToolTarget;
  profiles?: { name: string; description: string }[];
  areaPaths?: () => AreaPathTree | null;
  reviewModes?: string[];
  reviewAllowSkip?: boolean;
  permissions?: PermissionDesk;
  openPr?: {
    sink: ActionSink;
    defaultBranch: string;
    prompts: PromptTemplates;
    watchLabel: string;
    prRefStyle: PrRefStyle;
  };
  prReply?: PrReplyDesk;
  filing?: TicketFiler;
  watch?: WatchDryRunner;
  state?: Pick<StateQueryDesk, 'configured' | 'declare' | 'dryRun'>;
  reviewPacks?: Pick<ReviewPackAuthor, 'submit'>;
  reviewPackChecker?: Pick<ReviewPackChecker, 'submit'>;
  localValidations?: () => LocalValidationDesk;
  /**
   * The one reader of a run's report. It is a seam here rather than a body in the report tool
   * because folding a report needs the environment's config and its `at` command, and a tool module
   * holds neither — the tool stays an origin fence and a parse call.
   */
  remoteReadings?: () => RemoteReadingDesk;
  localRun?: () => { runner: LocalRunner; watch: LocalRunWatch };
  repoRoot?: string;
  /**
   * What the configured environments declare they can drive, which is the whole of who carries a
   * validation step. Absent is *nothing declared*, so every step is a person's — the direction this
   * has to fail in, because a step wrongly given to a fleet that cannot carry it is dispatched, held
   * and blocking nothing. → docs/spec/20-validation.md#who-carries-a-step
   */
  stepCapabilities?: StepCapabilities;
  errors?: ErrorRecorder;
}

interface PrReplyDesk {
  proposeReply(input: {
    agentId: string;
    prNumber: number;
    commentId: string | null;
    draft: string;
    resolve: boolean;
    originRef: string;
    reason: string;
  }): Promise<{ outcome: DecisionOutcome; detail: string }>;
}

export interface McpIdentity {
  agent: Agent;
  task: Task;
}

interface StatusEnvelope {
  origin: string | null;
  task: { title: string; status: string };
  awaitingHuman: { prompt: string } | null;
  plan?: { status: string; parts: { slug: string; status: string }[] };
}

function statusEnvelope(store: Store, agent: Agent, task: Task): StatusEnvelope {
  const open = store.escalations.listOpenEscalations().find((e) => e.agentId === agent.id) ?? null;
  const env: StatusEnvelope = {
    origin: task.originRef,
    task: { title: task.title, status: task.status },
    awaitingHuman: open ? { prompt: open.prompt } : null,
  };
  const issue = originIssueNumber(task.originRef);
  const plan = issue === null ? null : store.plans.getPlanByOrigin(issueOrigin(issue));
  if (plan) {
    env.plan = {
      status: plan.status,
      parts: store.plans.listPlanParts(plan.id).map((p) => ({ slug: p.slug, status: p.status })),
    };
  }
  return env;
}

interface ToolContext {
  deps: McpToolDeps;
  agent: Agent;
  task: Task;
  ok: (payload: Record<string, unknown>) => ToolCallResult;
}

export type ToolFactory = (ctx: ToolContext) => Omit<McpTool, 'name'>;

export function buildToolContext(deps: McpToolDeps, identity: McpIdentity): ToolContext {
  const { agent, task } = identity;
  return {
    deps,
    agent,
    task,
    ok: (payload) => toolJson({ ...payload, _status: statusEnvelope(deps.store, agent, task) }),
  };
}
