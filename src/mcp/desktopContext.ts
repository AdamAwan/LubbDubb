import type { PermissionDesk } from '../agents/permissionDesk.js';
import type { RecoveryDesk } from '../agents/recoveryDesk.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { LocalRunner } from '../localRun/runner.js';
import type { LocalRunWatch } from '../localRun/watch.js';
import type { PrRefStyle } from '../prRef.js';
import type { ProposalDesk } from '../proposals/proposalDesk.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { IssueWatchContext } from '../issueWatch.js';
import type { Store } from '../store/store.js';
import type { UpcomingPlan } from '../wire.js';
import type { McpTool } from './protocol.js';

/**
 * What the operator's own Claude Code is handed, and the deps behind it.
 *
 * Its own module because two files build the tools now — `desktopTools.ts` holds
 * the goal, plan and validation surface, `desktopOps.ts` the fleet one — and a
 * deps interface exported from one of them would make the other import it back.
 *
 * **The surface is narrowed by construction, not by a filter.** There is no code
 * path from a desktop connection to `conclude_work`, `open_pr` or any other fleet
 * tool, because neither module reaches `buildTools` and the desktop server reaches
 * nothing else. That matters more here than it does for the fleet: this credential
 * is long-lived, sits in the operator's home directory, and is held by a session
 * nobody dispatched — the blast radius of a filter that stopped filtering would be
 * the whole harness.
 *
 * **`plan_amend` is not `plan_submit`.** They carry the same document and share
 * the schema as one export rather than two literals — but the names differ on
 * purpose, because `validation_report` living on both channels is the trap this
 * repo has already been caught by once: an edit to "the plan tool" that silently
 * reaches only one side. What differs here is who may write and what settles
 * afterwards — the fleet's is fenced by the origin it was dispatched on, and this
 * one by the plan's own status, which decides between the two settlements it has:
 * a rewrite through `ingestPlanDocument` on `awaiting_approval`, and a proposal
 * on a plan that is already running.
 */
export interface DesktopToolDeps {
  store: Store;
  /** `validation.desktopClaimMinutes`. */
  claimMinutes: number;
  /** `config.validationRoot` — where a goal's fixtures live, which the session has to be told. */
  validationRoot: string;
  /**
   * `config.environments` — the deployments a goal's merged work travels to, in
   * the order the operator declared them.
   *
   * Here because "is it on hallway yet" is one of the questions {@link goalRead}
   * exists to answer, and the answer is a fold over the operator's own list: an
   * environment nobody configured is not a place work can have failed to reach.
   * Empty is the honest answer on a deployment that configured none, and the tool
   * says so rather than drawing a verdict about nowhere.
   */
  environments: EnvironmentConfig[];
  /**
   * How the configured provider links a pull request in prose, so the plan
   * rendering here names a part's pull request the way the operator's own
   * session can follow it. Omitted means `#`, which is right everywhere but
   * Azure DevOps. → `src/prRef.ts`
   */
  prRefStyle?: PrRefStyle;
  /**
   * The machine's one dev environment, lazily — the runner is built after this
   * server in `system.ts`, the same thunk `proposals` uses for the same reason.
   *
   * A handle on the runner rather than a copy of what to run: this channel and the
   * cockpit's panel both start a run, and they must be starting *the same thing*.
   * The tool used to render an instruction and let the session act on it, which
   * meant two definitions of what running meant and a harness that could not stop
   * what it had told somebody to start.
   */
  localRun(): LocalRunner;
  /**
   * The run's readings — ports and freshness — lazily, for the runner's reason: the
   * watch is built beside it, after this server.
   */
  localRunWatch(): LocalRunWatch;
  /**
   * The proposal desk, lazily — an amendment has to withdraw the card the
   * operator would otherwise approve, and the desk is constructed after this
   * server in `system.ts`. Same thunk the fleet deps use for `filing`.
   */
  proposals(): ProposalDesk;
  /** A manual cycle, lazily and for the same reason: it is what puts the fresh card up. */
  runCycle(): Promise<void>;

  /**
   * The live dispatch controls — the cap and the pause — read and written by
   * `fleet_status` and `fleet_control`. Direct rather than lazy: `RuntimeControl`
   * is constructed well above this server in `src/system.ts`.
   *
   * **By reference, never snapshotted at boot.** The cap is read on every
   * `WorktreeManager.ensure`, and a copy taken here would be a second opinion
   * about how big the fleet is.
   */
  runtimeControl: RuntimeControl;
  /**
   * The dispatcher's "Up next" projection from the last pulse, lazily — the
   * harness is built below this server in `src/system.ts`, as is everything else
   * in this block.
   *
   * A thunk over the harness rather than the plan itself, because the plan is
   * recomputed every cycle: a value captured here would be whatever the queue
   * looked like at boot, for ever.
   */
  harness(): { upcoming: UpcomingPlan | null };
  /** Where a question put to a person is answered — `escalation_answer`'s free-text arm. */
  escalations(): EscalationInbox;
  /**
   * The permission backstop. Its own arm on `escalation_answer` rather than a
   * second tool, for the route's reason: an agent blocked inside a tool call is
   * not at a prompt, so free text would type into nothing, and the two live in one
   * inbox that a session reads with one call.
   */
  permissions(): PermissionDesk;
  /** Agents orphaned by a crash — read by `attention_read`, and a refusal on `escalation_answer`. */
  recovery(): RecoveryDesk;
  /**
   * The outbound seam `goal_control`'s watch toggle writes the tag through.
   *
   * Narrowed to the one method rather than taking the whole `ActionSink`, and that
   * is the fence rather than a convenience: an `ActionSink` here would put
   * `mergePr`, `postPrReply` and `createIssue` one line away from a channel whose
   * whole claim is that it steers the fleet and never acts for it.
   */
  connector: IssueWatchContext['sink'];
  /**
   * Where a failed tag write is recorded. Optional for the reason everything on
   * this channel is best-effort: the server is constructed with one and a test
   * need not be, and a watch write that could not be logged is still a watch write.
   */
  errors?: ErrorRecorder;
  /** `config.labelPrefix` and `config.issueContainerTypes`, for `applyIssueWatch`. */
  labelPrefix: string;
  issueContainerTypes: string[];
  now(): string;
}

/**
 * What one desktop connection holds. Per-connection, not per-credential: two
 * terminals share one token, and a claim that belonged to the credential would
 * let the second report a reading against the first one's check.
 */
export interface DesktopSession {
  /** The label claims are taken under, as it appears in the cockpit. */
  label: string;
  /** The check this connection claimed, or null. Set by `validation_claim`. */
  held: { originRef: string; checkId: string; claimedAt: string | null } | null;
}

/**
 * How one tool is built: from the deps and the connection's own session, because
 * a claim belongs to the connection rather than to the credential.
 */
export type DesktopToolFactory = (deps: DesktopToolDeps, session: DesktopSession) => Omit<McpTool, 'name'>;
