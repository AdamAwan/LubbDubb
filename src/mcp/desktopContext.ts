import type { AgentManager } from '../agents/agentManager.js';
import type { AgentModels } from '../agents/modelPolicy.js';
import type { PermissionDesk } from '../agents/permissionDesk.js';
import type { RecoveryDesk } from '../agents/recoveryDesk.js';
import type { Config } from '../config.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { LocalRunner } from '../localRun/runner.js';
import type { LocalRunWatch } from '../localRun/watch.js';
import type { PrRefStyle } from '../prRef.js';
import type { ProposalDesk } from '../proposals/proposalDesk.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { IssueWatchContext } from '../issueWatch.js';
import type { SendResult, WorkItemAreaPathInput, WorkItemParentInput } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { UpcomingPlan } from '../wire.js';
import type { McpTool } from './protocol.js';

/**
 * What the operator's own Claude Code is handed, and the deps behind it. Its own
 * module because `desktopTools.ts` and `desktopOps.ts` both build tools from it.
 * The surface is narrowed by construction: neither module reaches `buildTools`,
 * so there is no code path from a desktop connection to a fleet tool.
 * → `docs/spec/11-mcp-tools.md#the-desktop-channel`
 */
export interface DesktopToolDeps {
  store: Store;
  /** `validation.desktopClaimMinutes`. */
  claimMinutes: number;
  /** `config.validationRoot` — where a goal's fixtures live. */
  validationRoot: string;
  /** `config.environments`, in declared order. Empty means no verdict is drawn. */
  environments: EnvironmentConfig[];
  /** How the configured provider links a pull request in prose. Omitted means `#`, wrong only on Azure DevOps. → `src/prRef.ts` */
  prRefStyle?: PrRefStyle;
  /** The machine's one dev environment, lazily (built after this server in `system.ts`). */
  localRun(): LocalRunner;
  /** The run's readings — ports and freshness — lazily, built beside the runner. */
  localRunWatch(): LocalRunWatch;
  /** The proposal desk, lazily — an amendment withdraws the card the operator would otherwise approve. */
  proposals(): ProposalDesk;
  /** A manual cycle, lazily — what puts the fresh card up. */
  runCycle(): Promise<void>;

  /**
   * The live dispatch controls — cap and pause — read/written by `fleet_status`
   * and `fleet_control`. By reference, never snapshotted: the cap is read on
   * every `WorktreeManager.ensure`.
   */
  runtimeControl: RuntimeControl;
  /** The dispatcher's last "Up next" projection, lazily. A thunk — the plan is recomputed every cycle. */
  harness(): { upcoming: UpcomingPlan | null };
  /** Where a question put to a person is answered — `escalation_answer`'s free-text arm. */
  escalations(): EscalationInbox;
  /** The fleet, for `agent_control`'s six verbs on a live session. */
  agents(): AgentManager;
  /** How the harness files a tracker item, lazily — `job_create`'s code arm files a watched ticket through the same `ticketFiler` the cockpit uses. */
  filing(): TicketFiler;
  /** The whole running config, lazily, for `submitBrief`. By reference — `labelPrefix` is live-applied. */
  briefConfig(): Config;
  /** Renders `brief-ticket-body`, which is operator-overridable. → `job_create`. */
  renderTicketBody(vars: Record<string, string>): string;
  /** The model profiles this deployment configures, for `goal_control`'s pin. An unknown name is refused. */
  profileNames(): string[];
  /** The permission backstop — its own arm on `escalation_answer`, since an agent blocked inside a tool call has no prompt for free text. */
  permissions(): PermissionDesk;
  /** Agents orphaned by a crash — read by `attention_read`, and a refusal on `escalation_answer`. */
  recovery(): RecoveryDesk;
  /**
   * The outbound seam this channel's four tracker writes go through: the watch
   * tag and model pin (`goal_control`), the container and area path
   * (`goal_placement`). Narrowed method by method rather than the whole
   * `ActionSink` — that narrowing fences this channel off from acting for the fleet.
   */
  connector: IssueWatchContext['sink'] & {
    canPlaceWorkItem(): boolean;
    setWorkItemParent(input: WorkItemParentInput): Promise<SendResult>;
    setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult>;
  };
  /** Where a failed tag write is recorded. Optional: a test need not supply one. */
  errors?: ErrorRecorder;
  /** `config.labelPrefix` and `config.issueContainerTypes`, for `applyIssueWatch`. */
  labelPrefix: string;
  issueContainerTypes: string[];
  /**
   * `config.agentModels`, for `goal_control`'s pin — writes the model *label* and
   * so needs the whole set, not just {@link DesktopToolDeps.profileNames}.
   * Undefined when none are configured, and the pin then refuses.
   */
  agentModels: AgentModels | undefined;
  now(): string;
}

/**
 * What one desktop connection holds. Per-connection, not per-credential: two
 * terminals share one token, and a credential-scoped claim would let the second
 * report a reading against the first one's check.
 */
export interface DesktopSession {
  /** The label claims are taken under, as it appears in the cockpit. */
  label: string;
  /** The check this connection claimed, or null. Set by `validation_claim`. */
  held: { originRef: string; checkId: string; claimedAt: string | null } | null;
}

/** How one tool is built: from the deps and the connection's own session. */
export type DesktopToolFactory = (deps: DesktopToolDeps, session: DesktopSession) => Omit<McpTool, 'name'>;
