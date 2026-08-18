import type { Store } from '../../store/store.js';
import type { ErrorRecorder } from '../../errorLog.js';
import type { PermissionDesk } from '../../agents/permissionDesk.js';
import type {
  Agent,
  AgentAsk,
  Finding,
  FindingInput,
  HumanTask,
  HumanTaskInput,
  IssueConclusion,
  IssueConclusionVerdict,
  PartOutcomeKind,
  PlanPart,
  ScratchEntry,
  ShortfallCause,
  Task,
  WorkItemFiling,
  BugFiling,
} from '../../types.js';
import type { ActionSink } from '../../sink/actionSink.js';
import type { PromptTemplates } from '../../dispatcher/promptTemplates.js';
import type { AssessmentVerdict } from '../assessment.js';
import type { GoalAssayVerdictName } from '../goalAssay.js';
import { issueOrigin, planOriginIssue } from '../../plans/planning.js';
import { type McpTool, toolJson, type ToolCallResult } from '../protocol.js';

/**
 * What the tool layer needs from the fleet. Narrow on purpose, and every method
 * is here for the same reason: each has a fleet-side transition or event that
 * must not be bypassed. `ask` goes through the *same* park the WAITING sentinel
 * drives; `recordFinding` and `recordProgress` persist and then emit, so the
 * cockpit hears the moment it happens rather than on the next pulse.
 */
export interface AgentToolTarget {
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string };
  recordFinding(
    agentId: string,
    input: FindingInput,
  ): { ok: true; finding: Finding; created: boolean } | { ok: false; error: string };
  requestHumanTask(
    agentId: string,
    input: HumanTaskInput,
  ): { ok: true; task: HumanTask } | { ok: false; error: string };
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string };
  linkTicket(
    agentId: string,
    ticketRef: string,
  ):
    | { ok: true; finding: Finding; filing?: undefined; bug?: undefined }
    | {
        ok: true;
        filing: WorkItemFiling;
        finding?: undefined;
        bug?: undefined;
        /** How many of the operator's images moved from the filing job onto the ticket (issue #249). */
        attachments: number;
      }
    | { ok: true; bug: BugFiling; finding?: undefined; filing?: undefined }
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
  recordAssay(
    agentId: string,
    verdict: GoalAssayVerdictName,
    summary: string,
    profile: string | null,
  ):
    | {
        ok: true;
        issueOrigin: string;
        verdict: GoalAssayVerdictName;
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
  recordRetrospective(
    agentId: string,
    summary: string,
    document: string,
  ): { ok: true; issueOrigin: string } | { ok: false; error: string };
}

export interface McpToolDeps {
  store: Store;
  agents: AgentToolTarget;
  /**
   * This deployment's model profiles, cheapest first, as `assay_issue` presents
   * them to an assayer (issue #342). Absent or empty for a deployment with no
   * `agentModels`, which is what turns the whole proposal off: no argument is
   * offered, none is required, and every dispatch resolves on its rule alone.
   */
  profiles?: { name: string; description: string }[];
  /** `planning.requireApproval` — see `ingestPlanDocument`. */
  requirePlanApproval?: boolean;
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
  };
  errors?: ErrorRecorder;
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
  const issue = planOriginIssue(task.originRef);
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
