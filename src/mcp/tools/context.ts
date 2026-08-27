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
  KnowledgeFact,
  KnowledgeGraduation,
  PartOutcomeKind,
  PlanPart,
  Remedy,
  ScratchEntry,
  ShortfallCause,
  DecisionOutcome,
  Task,
  BugFiling,
} from '../../types.js';
import type { ActionSink } from '../../sink/actionSink.js';
import type { TicketFiler } from '../../tickets/filing.js';
import type { PromptTemplates } from '../../dispatcher/promptTemplates.js';
import type { PrRefStyle } from '../../prRef.js';
import type { AssessmentVerdict } from '../assessment.js';
import type { GoalAppraisalVerdictName } from '../goalAppraisal.js';
import type { AreaPathTree } from '../../intake/placement.js';
import type { RemedySubmission } from '../../remedies/remedies.js';
import type { FactContradiction, FactProposal } from '../../knowledge/knowledge.js';
import type { FeatureSummaryInput } from '../../summaries/featureSummary.js';
import type { FactAgreementOutcome, FactContradictionOutcome, FactProposalOutcome } from '../../store/knowledge.js';
import { issueOrigin, originIssueNumber } from '../../plans/planning.js';
import { type McpTool, toolJson, type ToolCallResult } from '../protocol.js';

/**
 * What the tool layer needs from the fleet. Narrow on purpose, and every method
 * is here for the same reason: each has a fleet-side transition or event that
 * must not be bypassed. `ask` goes through the *same* park the WAITING sentinel
 * drives; `proposeFact` and `recordProgress` persist and then emit, so the
 * cockpit hears the moment it happens rather than on the next pulse.
 */
export interface AgentToolTarget {
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string };
  requestHumanTask(
    agentId: string,
    input: HumanTaskInput,
  ): { ok: true; task: HumanTask } | { ok: false; error: string };
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string };
  /**
   * Which filing this credential resolves to — asked *before* the item is created,
   * because the harness files it and a bug is created as a different type and
   * linked back to its story (issue #394).
   */
  filingTarget(
    agentId: string,
  ): { ok: true; kind: 'claim' | 'bug'; storyNumber: number | null } | { ok: false; error: string };
  linkTicket(
    agentId: string,
    ticketRef: string,
  ):
    | { ok: true; graduation: KnowledgeGraduation; bug?: undefined }
    | { ok: true; bug: BugFiling; graduation?: undefined }
    | { ok: false; error: string };
  recordConclusion(
    agentId: string,
    verdict: IssueConclusionVerdict,
    note: string,
  ): { ok: true; conclusion: IssueConclusion } | { ok: false; error: string };
  recordAssessment(
    agentId: string,
    verdict: AssessmentVerdict,
    summary: string,
    detail: string | null,
    cause: ShortfallCause | null,
    part: string | null,
  ): { ok: true; issueOrigin: string; verdict: AssessmentVerdict } | { ok: false; error: string };
  /**
   * The planner's "there is nothing to build here". Takes no issue argument for
   * the reason none of these do: the issue is the credential's own.
   */
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
     * Where the appraiser says this goal belongs on the backlog — the container it
     * should hang off, and the area node it should sit on. Both null where it
     * proposed neither, which is every `unclear` verdict and every flat tracker.
     *
     * One object rather than two more positional arguments: they are one
     * statement about placement, they arrive together, and a fifth and sixth
     * `string | null` beside `profile` is a call site where two nulls can be
     * transposed with nothing red.
     */
    placement?: { parent: number | null; areaPath: string | null },
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
  ): { ok: true; entry: ScratchEntry } | { ok: false; error: string };
  readScratch(agentId: string): { ok: true; padRef: string; entries: ScratchEntry[] } | { ok: false; error: string };
  /**
   * The Feature's own account of itself. Takes no container argument for the
   * reason none of these do: the Feature is the credential's own.
   */
  recordFeatureSummary(
    agentId: string,
    input: FeatureSummaryInput,
  ): { ok: true; featureOrigin: string } | { ok: false; error: string };
  recordRetrospective(
    agentId: string,
    summary: string,
    document: string,
    lessons: string[],
  ): { ok: true; issueOrigin: string; lessonsFiled: number } | { ok: false; error: string };
  recordRemedy(
    agentId: string,
    submission: RemedySubmission,
  ): { ok: true; remedy: Remedy; raised: FactProposalOutcome | null } | { ok: false; error: string };
  proposeFact(
    agentId: string,
    proposal: FactProposal,
  ): { ok: true; outcome: FactProposalOutcome } | { ok: false; error: string };
  agreeWithFact(
    agentId: string,
    factId: string,
    evidence: string,
  ): { ok: true; outcome: FactAgreementOutcome } | { ok: false; error: string };
  contradictFact(
    agentId: string,
    contradiction: FactContradiction,
  ): { ok: true; outcome: FactContradictionOutcome } | { ok: false; error: string };
  askKnowledge(
    agentId: string,
    query: { question: string | null; scopes: readonly string[] | null },
  ): { ok: true; scopes: string[]; facts: AnsweredFact[] } | { ok: false; error: string };
}

/** One fact as an asking agent reads it: the claim, and enough provenance to weigh it. */
export interface AnsweredFact {
  fact: KnowledgeFact;
  /** How many independent goals have said they saw it. */
  corroborations: number;
}

export interface McpToolDeps {
  store: Store;
  agents: AgentToolTarget;
  /**
   * This deployment's model profiles, cheapest first, as `appraise_issue` presents
   * them to an appraiser (issue #342). Absent or empty for a deployment with no
   * `agentModels`, which is what turns the whole proposal off: no argument is
   * offered, none is required, and every dispatch resolves on its rule alone.
   */
  profiles?: { name: string; description: string }[];
  /**
   * The project's area tree as the harness last read it, or null where the
   * tracker has no such concept and while the first read has not landed.
   *
   * A thunk for the reason `agents` and `openPr` are: the directory behind it is
   * refreshed on the pulse, and a value captured when the tool set was composed
   * would pin every later agent to the tree as it stood at the first launch. Read
   * at description-build time, which is why it cannot be a promise.
   */
  areaPaths?: () => AreaPathTree | null;
  /**
   * The review modes this project declared, in declaration order, as
   * `review_route` offers them to a triage agent. Empty or absent for a
   * deployment that declared none — and then no triage is ever dispatched, so
   * nothing is calling the tool anyway.
   */
  reviewModes?: string[];
  /**
   * The permission backstop (issue #130 phase B). Present when
   * `mcp.permissionEscalation` is on; the `request_permission` tool blocks on it.
   * Absent, that tool reports the backstop is off rather than blocking forever.
   */
  permissions?: PermissionDesk;
  /**
   * What `open_pr` needs to author a pull request. Optional, and that is the
   * degradation floor rather than laziness: unwired — no sink, `mcp.enabled` off,
   * a `claude` that ignores the server — an agent opens its own PR exactly as it
   * did before the tool existed, which is what every prompt still tells it to do.
   */
  openPr?: {
    sink: ActionSink;
    defaultBranch: string;
    prompts: PromptTemplates;
    /**
     * `${labelPrefix}-watch`, written onto the pull request as it is created so the
     * fleet keeps working what it just opened (pull requests are opt-in). Empty =
     * the gate is off, and nothing is tagged because nothing needs to be.
     */
    watchLabel: string;
    /**
     * How this provider links a pull request in prose, so the body guidance can
     * name the sigil rather than leave the agent to GitHub's habit. On Azure a
     * sibling pull request written `#12` links to *work item* 12.
     * → `src/prRef.ts`
     */
    prRefStyle: PrRefStyle;
  };
  /**
   * Where `reply_to_review` hands the reply it was given. The `ActionExecutor`,
   * narrowed to the one method — the tool raises a `reply_on_pr` act and returns,
   * because the executor is the only path that asks the hold, applies the
   * operator's authority and signs what goes out.
   *
   * Optional for {@link McpToolDeps.openPr}'s reason, and the floor is *not* the
   * agent posting it itself: unwired, the tool says so and tells the agent to put
   * the reply in its summary. An agent posting with the operator's credential is
   * the behaviour this tool exists to end, so it cannot be the fallback.
   */
  prReply?: PrReplyDesk;
  /**
   * How `link_ticket` creates the item an agent has written up (issue #394).
   * Optional for {@link McpToolDeps.openPr}'s reason and with the same floor: with
   * no tracker configured there is nothing to file into, nothing dispatches a
   * filing job, and the tool says so rather than pretending.
   */
  filing?: TicketFiler;
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
    reason: string;
  }): Promise<{ outcome: DecisionOutcome; detail: string }>;
}

/** A resolved caller: the agent row the credential names, and its task. */
export interface McpIdentity {
  agent: Agent;
  task: Task;
}

/**
 * The situational-awareness envelope every tool response carries. Cheap to
 * compute and it removes the need for a polling tool: an agent that calls
 * anything at all learns its origin, whether a human is currently parked on it,
 * and how its plan is progressing.
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
 * What one tool's body runs against — the seam between the assembly in
 * `../tools.ts` and the module per tool beside this file.
 *
 * Every tool used to be an object literal inside one 844-line function, sharing
 * that function's scope: the caller, the deps and the `ok` helper were closed
 * over rather than named, so "what does a tool get to reach" had no answer short
 * of reading the whole thing. This is the answer, and it is the same shape
 * `StageContext` gives a dispatch rule for the same reason.
 *
 * **The caller is on the context, never in an argument.** That is the channel's
 * one structural guarantee (`token -> agent -> task -> origin`), and putting the
 * resolved identity here rather than letting a handler read it from its own args
 * is what keeps a tool module from being able to accept one.
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
 * One tool's body: everything except its name.
 *
 * The name is supplied by the registry in `../tools.ts`, keyed on
 * `MCP_TOOL_NAMES`, so a module cannot name itself something the launch config's
 * `--allowedTools` grants do not cover — the "connected server whose every call
 * is refused" trap `names.ts` exists to prevent, now closed at compile time
 * rather than by an array index literal per module.
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
