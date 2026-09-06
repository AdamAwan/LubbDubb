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
import { issueOrigin, originIssueNumber } from '../../plans/planning.js';
import { type McpTool, toolJson, type ToolCallResult } from '../protocol.js';

/**
 * What the tool layer needs from the fleet. Narrow on purpose: every method here has a
 * fleet-side transition or event that must not be bypassed. `ask` goes through the same park the
 * WAITING sentinel drives; `recordProgress` persists and then emits, so the cockpit hears the
 * moment it happens rather than on the next pulse.
 */
export interface AgentToolTarget {
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string };
  requestHumanTask(
    agentId: string,
    input: HumanTaskInput,
  ): { ok: true; task: HumanTask } | { ok: false; error: string };
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string };
  /** Which filing this credential resolves to, asked before the item is created — a bug is a different type, linked back to its story (issue #394). */
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
  /** The planner's "there is nothing to build here". No issue argument: the issue is the credential's own. */
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
    /**
     * Where the appraiser says this goal belongs — the container and area node. Both null where
     * it proposed neither. One object rather than positional args since they arrive together as
     * one statement, and `missing` rides along as what an `unclear` verdict says beside its summary.
     */
    placement?: { missing?: string[]; parent: number | null; areaPath: string | null },
  ):
    | {
        ok: true;
        issueOrigin: string;
        verdict: GoalAppraisalVerdictName;
        /** Whether the proposal diverged and is now holding the funnel on a human. */
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
  /** The Feature's own account of itself. No container argument: the Feature is the credential's own. */
  recordFeatureSummary(
    agentId: string,
    input: FeatureSummaryInput,
  ): { ok: true; featureOrigin: string } | { ok: false; error: string };
  /** The order the stories under the credential's own Feature go in. Always a proposal — nothing the fleet says about its own output may hold work. */
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
  /**
   * This deployment's model profiles, cheapest first, as `appraise_issue` presents them
   * (issue #342). Absent/empty for no `agentModels` — turns the whole proposal off, so every
   * dispatch resolves on its rule alone.
   */
  profiles?: { name: string; description: string }[];
  /**
   * The project's area tree as the harness last read it, or null with no such tracker concept or
   * before the first read lands. A thunk (not a promise): read at description-build time, so a
   * captured value would pin every later agent to the tree as it stood at the first launch.
   */
  areaPaths?: () => AreaPathTree | null;
  /** The review modes this project declared, in declaration order, as `review_route` offers them. Empty/absent = none declared, so nothing dispatches a triage anyway. */
  reviewModes?: string[];
  /** Whether triage may answer "needs no review" (`review.allowSkip`). Absent reads as off. */
  reviewAllowSkip?: boolean;
  /** The permission backstop (issue #130 phase B). Present only when `mcp.permissionEscalation` is on; absent, `request_permission` reports the backstop off rather than blocking forever. */
  permissions?: PermissionDesk;
  /** What `open_pr` needs to author a pull request. Optional: unwired, an agent opens its own PR exactly as it did before the tool existed. */
  openPr?: {
    sink: ActionSink;
    defaultBranch: string;
    prompts: PromptTemplates;
    /** `${labelPrefix}-watch`, written on creation so the fleet keeps working what it just opened. Empty = the gate is off. */
    watchLabel: string;
    /** How this provider links a pull request in prose — on Azure a sibling `#12` links to *work item* 12. → `src/prRef.ts` */
    prRefStyle: PrRefStyle;
  };
  /**
   * Where `reply_to_review` hands its reply — the `ActionExecutor`, narrowed to one method,
   * because the executor is the only path that checks the hold, applies operator authority and
   * signs what goes out. Optional, and the floor is *not* the agent posting it itself — that is
   * the behaviour this tool exists to end — so unwired it tells the agent to put the reply in
   * its summary instead.
   */
  prReply?: PrReplyDesk;
  /** How `link_ticket` creates the item an agent wrote up (issue #394). Optional: with no tracker configured, the tool says so rather than pretending. */
  filing?: TicketFiler;
  /** The post-deploy watch's dry run, as `plan_submit` reaches it: every declared check put to the environment once, the moment the plan lands. Optional: unwired, nothing is asked of any environment. */
  watch?: WatchDryRunner;
  /** Where `review_pack_submit` hands its pack — the author desk, narrowed to one method. Optional: unwired, nothing is recorded. */
  reviewPacks?: Pick<ReviewPackAuthor, 'submit'>;
  /** Where `review_pack_check` hands its verdicts — merged onto the stored document. Same shape and floor as {@link McpToolDeps.reviewPacks}. */
  reviewPackChecker?: Pick<ReviewPackChecker, 'submit'>;
  /**
   * The checkout an obstacle's `path` key is validated against — `config.repoRoot`. Optional:
   * unwired, path keys are dropped and the report is kept rather than filing a refusal the agent
   * cannot satisfy.
   */
  /**
   * The desk the three local-validation tools write through, as thunks — construction order
   * requires it, since the MCP server is built above the local runner in `system.ts`. Optional:
   * unwired, the tools answer that they are not available on this deployment.
   */
  localValidations?: () => LocalValidationDesk;
  /** The environment as `local_run_read` reads it: the runner and its watch, same terms. */
  localRun?: () => { runner: LocalRunner; watch: LocalRunWatch };
  repoRoot?: string;
  errors?: ErrorRecorder;
}

/** The executor, as the reply tool reaches it. */
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

/** A resolved caller: the agent row the credential names, and its task. */
export interface McpIdentity {
  agent: Agent;
  task: Task;
}

/**
 * The situational-awareness envelope every tool response carries. Cheap to compute and removes
 * the need for a polling tool: any call at all tells an agent its origin, whether a human is
 * parked on it, and how its plan is progressing.
 */
interface StatusEnvelope {
  origin: string | null;
  task: { title: string; status: string };
  /** The open escalation this agent is parked on, if any. */
  awaitingHuman: { prompt: string } | null;
  /** Progress roll-up when the agent's issue has a plan; absent otherwise. */
  plan?: { status: string; parts: { slug: string; status: string }[] };
}

function statusEnvelope(store: Store, agent: Agent, task: Task): StatusEnvelope {
  const open = store.listOpenEscalations().find((e) => e.agentId === agent.id) ?? null;
  const env: StatusEnvelope = {
    origin: task.originRef,
    task: { title: task.title, status: task.status },
    awaitingHuman: open ? { prompt: open.prompt } : null,
  };
  const issue = originIssueNumber(task.originRef);
  const plan = issue === null ? null : store.getPlanByOrigin(issueOrigin(issue));
  if (plan) {
    env.plan = {
      status: plan.status,
      parts: store.listPlanParts(plan.id).map((p) => ({ slug: p.slug, status: p.status })),
    };
  }
  return env;
}

/**
 * What one tool's body runs against — the seam between the assembly in `../tools.ts` and the
 * module per tool beside this file, replacing an 844-line function every tool used to be an
 * object literal inside, sharing its scope. Same shape `StageContext` gives a dispatch rule, for
 * the same reason.
 *
 * The caller is on the context, never in an argument — the channel's one structural guarantee
 * (`token -> agent -> task -> origin`) — so a tool module cannot be written to accept one.
 */
interface ToolContext {
  /** The wiring the channel was built with, verbatim. */
  deps: McpToolDeps;
  /** The agent the credential resolved to. */
  agent: Agent;
  /** Its task — the origin every fence and every attribution is taken from. */
  task: Task;
  /** A success reply, with the situational-awareness envelope folded in. */
  ok: (payload: Record<string, unknown>) => ToolCallResult;
}

/**
 * One tool's body: everything except its name. The name is supplied by the registry in
 * `../tools.ts`, keyed on `MCP_TOOL_NAMES`, so a module cannot name itself something the launch
 * config's `--allowedTools` grants do not cover — closed at compile time rather than by an array
 * index literal per module.
 */
export type ToolFactory = (ctx: ToolContext) => Omit<McpTool, 'name'>;

/** Build the context one resolved caller's tools run against. */
export function buildToolContext(deps: McpToolDeps, identity: McpIdentity): ToolContext {
  const { agent, task } = identity;
  return {
    deps,
    agent,
    task,
    ok: (payload) => toolJson({ ...payload, _status: statusEnvelope(deps.store, agent, task) }),
  };
}
