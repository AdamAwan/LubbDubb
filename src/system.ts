import { tmpdir } from 'node:os';
import { prRefStyle } from './prRef.js';
import { join } from 'node:path';
import { configFilePath, projectConfigFilePath, type Config } from './config.js';
import { Store } from './store/store.js';
import { CompositeConnector } from './integrations/compositeConnector.js';
import { buildIntegrations, buildPoolTransport } from './integrations/registry.js';
import { PoolDesk } from './pool/poolDesk.js';
import { harnessVersion } from './pool/harnessVersion.js';
import type { ActionSink } from './sink/actionSink.js';
import { ticketFiler, type TicketFiler } from './tickets/filing.js';
import { ghCliUpstreamIssues, type UpstreamIssues } from './tickets/upstream.js';
import type { CiEvidenceReader } from './ci/ciEvidence.js';
import { ticketAmendCommands } from './goalInstructions.js';
import { NodePtyBackend, type PtyBackend } from './pty/backend.js';
import { defaultSessionRoot } from './agents/sessionTranscript.js';
import { defaultPoolSize, WorktreeManager, type Worktrees } from './worktree/worktreeManager.js';
import { GitCliObserver, type GitObserver } from './git/gitObserver.js';
import { fetchRemote } from './git/gitCli.js';
import { PlanReconciler } from './plans/planReconciler.js';
import { AppraisalDesk } from './intake/appraisalDesk.js';
import { AreaPathDirectory } from './intake/areaPaths.js';
import type { AreaPathTree } from './intake/placement.js';
import { TicketSweep } from './tickets/sweep.js';
import { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import { AgentManager } from './agents/agentManager.js';
import {
  buildClaudeArgs,
  buildClaudeStreamArgs,
  buildInitialMessage,
  buildResumeMessage,
} from './agents/agentProtocol.js';
import { PtySession } from './pty/ptySession.js';
import { StreamJsonSession, type Spawner } from './agents/streamJsonSession.js';
import { StatusFileRateLimits } from './agents/statusLine.js';
import { FileEventsSpool } from './agents/fileEvents.js';
import { AttachmentFiles } from './jobs/attachmentFiles.js';
import type { SessionFactory } from './agents/session.js';
import { killProcessTree, type ProcessReaper } from './agents/processTree.js';
import { EscalationInbox } from './escalation/escalationInbox.js';
import { ProposalDesk } from './proposals/proposalDesk.js';
import { StackLandingDesk } from './stacks/landingDesk.js';
import { escalationTypeForAsk, recentOutputExcerpt } from './escalation/context.js';
import { defaultConfigDir, defaultSocketPath, McpBridgeServer } from './mcp/server.js';
import { McpDesktopServer } from './mcp/desktop.js';
import { KNOWLEDGE_READ_LIMIT, renderKnowledgeBlock } from './knowledge/block.js';
import { KnowledgeClusterDesk } from './knowledge/cluster.js';
import { KnowledgeGraduationDesk } from './knowledge/graduationDesk.js';
import { KnowledgeNoticeDesk } from './knowledge/noticeDesk.js';
import { PrNamingDesk } from './prNamingDesk.js';
import { DeliveryCloseOutDesk } from './delivery/closeOutDesk.js';
import { ValidationAskDesk } from './validation/askDesk.js';
import { ValidationReadyDesk } from './validation/readyDesk.js';
import { SpendBurnDesk } from './spendBurnDesk.js';
import { RunwayDesk } from './supply/runwayDesk.js';
import { BranchReapDesk } from './branchReapDesk.js';
import { EnvironmentDesk } from './environments/environmentDesk.js';
import { CommandEnvironmentProber, type EnvironmentProber } from './environments/prober.js';
import { PrWatchDesk } from './prWatchDesk.js';
import { PrWorkItemDesk } from './prWorkItemDesk.js';
import { ScheduleDesk } from './schedules/scheduleDesk.js';
import { UpdateDesk } from './selfUpdate/updateDesk.js';
import type { McpToolDeps } from './mcp/tools/context.js';
import { PERMISSION_PROMPT_TOOL } from './mcp/names.js';
import { PermissionDesk } from './agents/permissionDesk.js';
import { RecoveryDesk } from './agents/recoveryDesk.js';
import { ActionExecutor } from './executor/actionExecutor.js';
import { RuleDispatcher } from './dispatcher/ruleDispatcher.js';
import { loadPromptTemplates, type PromptTemplates } from './dispatcher/promptTemplates.js';
import { loadReviewCharter } from './review/charter.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import { openPrForIssue, type IssuePickupPolicy } from './dispatcher/issuePickup.js';
import { watchLabelFor } from './watchLabels.js';
import { featureBoardOn } from './features/featureBoard.js';
import { featureRecords } from './summaries/featureRecord.js';
import { resolveModelTag } from './modelLabels.js';
import { orderedProfiles } from './agents/modelPolicy.js';
import { Harness } from './harness.js';
import { RuntimeControl } from './runtimeControl.js';
import { PetKeeper } from './pets/keeper.js';
import { LocalRunner } from './localRun/runner.js';
import { localRunChoices } from './localRun/ref.js';
import { planIssueNumber } from './plans/parts.js';
import { LiveConfig } from './configApply.js';
import { ErrorLog } from './errorLog.js';
import type { ErrorLogEntry } from './types.js';

export interface System {
  config: Config;
  store: Store;
  connector: CompositeConnector;
  agents: AgentManager;
  escalations: EscalationInbox;
  /**
   * Where a human's accept/reject on a proposed act is applied (issue #109) — the
   * missing wire between "approve" and "the approved thing happens".
   */
  proposals: ProposalDesk;
  /**
   * Where an operator's standing authorization to land a whole stack is recorded,
   * ended, and reconciled with the world each pulse (see `src/stacks/landing.ts`).
   */
  landings: StackLandingDesk;
  /**
   * The permission backstop (issue #130 phase B): where an agent's tool call that
   * the allow-list doesn't cover blocks until the operator allows or denies it.
   */
  permissions: PermissionDesk;
  /**
   * The project's area tree, cached. Read by the state snapshot to tell an
   * unclassified work item from a classified one, and by the appraisal tool to offer
   * the nodes — both synchronously, which is the whole reason it is a directory
   * rather than a provider call.
   */
  areaPaths: AreaPathDirectory;
  /**
   * Where agents orphaned by a crash or a shutdown wait for an operator to choose
   * restore / requeue / remove. Its pending set holds the harness's pulse, so no
   * new work is queued in front of work that was already in flight.
   */
  recovery: RecoveryDesk;
  executor: ActionExecutor;
  dispatcher: Dispatcher;
  harness: Harness;
  /**
   * Writes the durable work graph each pulse. Exposed because the record outlives
   * the world's memory of it — the routes and tests that read the graph back have
   * no other handle on the thing that wrote it.
   */
  graph: WorkGraphRecorder;
  /**
   * Keeps the ticket mirror current, and the one thing that knows whether the
   * first sweep has landed. Exposed because `/api/tickets` has to say so: an empty
   * list mid-backfill and an empty list on an empty tracker are the same picture
   * and different facts.
   */
  tickets: TicketSweep;
  /**
   * The cross-fleet pool, or undefined on the `fake` default.
   *
   * Exposed because the cockpit reads its status — what this fleet last published,
   * when it last polled, and which claims the secret backstop refused — and because
   * the routes have no other handle on the thing that holds it. Absent, the Knowledge
   * page draws no pool section at all, which is the honest reading rather than an
   * empty one. → `docs/spec/28-cross-fleet-pool.md`
   */
  pool?: PoolDesk;
  /**
   * Files a tracker item (issue #394). Exposed because filing is **route-driven**:
   * the operator clicks, waits, and is told the item's ref — so it is neither an
   * executor action nor a desk pass on the pulse, and the four routes reach it
   * here.
   */
  filing: TicketFiler;
  /**
   * Files a report about **LubbDubb itself** into LubbDubb's own tracker, past the
   * connector entirely (issue #449). Route-driven for {@link filing}'s reason: the
   * operator clicks, waits, and is told what was created.
   */
  upstream: UpstreamIssues;
  /**
   * Where the harness watches its **own** build and drives a deliberate upgrade of
   * it. Always constructed and always exposed — the route and the snapshot need a
   * handle on it either way, and with the watch off it simply never takes a
   * reading, so the gauge reads unknown and every action refuses with that reason.
   * `main.ts` is what gives it a way to hand this process off.
   */
  updates: UpdateDesk;
  /** Live, ephemeral dispatch controls (cap + pause). Seeded from config at boot. */
  runtimeControl: RuntimeControl;
  /**
   * The vivarium (`src/pets/`). Always constructed; with `pets.enabled` off it
   * scans nothing and reports null, which is what the snapshot ships and what the
   * routes refuse on — one object either way, rather than an optional every
   * caller has to remember to check twice.
   */
  pets: PetKeeper;
  /**
   * The machine's one dev environment (`src/localRun/`): which goal's code is in it,
   * and the process holding it up. Always constructed, `pets`' reason — with no
   * `localRun.instruction` every start refuses with that as the reason, which is a
   * surface that says why rather than one that is quietly missing. Exposed because
   * it is route- and tool-driven rather than a pass on the pulse: an operator
   * clicks, or their own Claude asks, and nothing about it happens on a cycle.
   */
  localRun: LocalRunner;
  /**
   * Applies a reloaded config to this running process, and holds what is waiting
   * for a restart. The one apply path a cockpit save and a hand edit to
   * `lubbdubb.config.json` both go through.
   */
  liveConfig: LiveConfig;
  /**
   * The issue-pickup policy the dispatcher honours, exposed so the snapshot can
   * compute the same per-issue pickup verdict the dispatcher will act on.
   */
  issuePickup: IssuePickupPolicy;
  /**
   * The operator-customisable prompt book. Exposed because one prompt is
   * route-driven rather than dispatcher-driven: filing a finding as a ticket
   * (`finding-ticket`), which renders on a click rather than on a pulse.
   */
  prompts: PromptTemplates;
  /**
   * Account rate-limit capture (status-line payloads), wired only for the PTY
   * runtime — the status line never fires headless. Null in other modes; the
   * snapshot then falls back to the rolling cost windows from `usage_events`.
   */
  rateLimits: StatusFileRateLimits | null;
  /**
   * Per-agent spool for the file-events `PostToolUse` hook — where written paths
   * land before {@link AgentManager.drainFileEvents} folds them into the files
   * list / artifact chips. Always present; the hook feeding it is only wired for
   * the real runtimes (stream/pty).
   */
  fileEvents: FileEventsSpool;
  /**
   * Where images attached to a brief are written (issue #249). Exposed because
   * the launch route stores them and the cancel route removes them, and both need
   * the same root the agents are granted read access to.
   */
  attachments: AttachmentFiles;
  /**
   * The agents' typed channel back to the harness (issue #108). Always present,
   * but inert until `listen()` succeeds *and* `config.mcp.enabled` let it reach
   * the fleet — so a system built without either behaves exactly as it did before
   * the channel existed. Tests reach tools through `mcp.session(agentId)`, which
   * is the same entry point an agent's bridge lands on.
   */
  mcp: McpBridgeServer;
  /**
   * The operator's own Claude Code channel — validation checks run at their
   * keyboard, on a machine that can reach what the fleet cannot. Always present
   * and always constructed, but it binds nothing and writes no credential until
   * `listen()` is called, which `main.ts` does unconditionally at boot. A test's
   * system therefore has the channel addressable and listening on nothing.
   */
  desktop: McpDesktopServer;
  /**
   * The pool of worktree directories code dispatch leases slots from. Exposed
   * because the lease is a property of the *whole* dispatch path — a slot held by a
   * live agent is never handed to a second branch — and asserting that needs the
   * same manager the executor and the reap are wired to, not a second one.
   */
  worktrees: Worktrees;
  /** Central error log: every caught failure is persisted here and streamed to the cockpit. */
  errors: ErrorLog;
  /**
   * The config file a save writes and the watcher watches. Defaults to
   * `lubbdubb.config.json` beside the launch directory, which for the test suite
   * is **this repository** — so a test that exercises the config route without
   * overriding it rewrites the developer's own config. Same hazard as
   * `config.repoRoot` defaulting to `process.cwd()`, and the same fix: tests
   * inject a temp path.
   */
  configFile: string;
  /**
   * The **targeted project's** shared config, at `<repoRoot>/lubbdubb.project.json`
   * — the team's layer, underneath the operator's own file.
   *
   * Held here for `configFile`'s reason exactly: `config.repoRoot` defaults to
   * `process.cwd()`, so a test that read this path off the running config would
   * read whatever project config the checkout the suite runs in happens to carry
   * — and pass or fail by machine on a file nobody wrote for it.
   */
  projectConfigFile: string;
}

interface BuildOptions {
  /** Inject a fake PTY backend (tests) instead of the real node-pty one. */
  backend?: PtyBackend;
  /** Override the outbound sink (tests). Defaults to the FakeConnector. */
  sink?: ActionSink;
  /**
   * Override where a CI-fix dispatch's failing output comes from (tests inject a
   * provider integration built on a scripted `*Api`). Defaults to the composite,
   * which answers `[]` unless the selected provider can supply any.
   */
  ciEvidence?: CiEvidenceReader;
  /** Inject a fake process spawner (tests) for the stream-JSON runtime. */
  streamSpawner?: Spawner;
  /**
   * Override how a killed agent's process *subtree* is taken down (tests inject a
   * recorder). Defaulted below, and defaulted to a no-op whenever a fake transport
   * is injected — see the wiring for why that pairing is not optional.
   */
  reapProcessTree?: ProcessReaper;
  /**
   * Override the git observer plan reconciliation reads branch reality through
   * (tests inject `FakeGitObserver`). Injecting one also turns the reconciler's
   * `git fetch` off — a scripted observer has no remote to refresh.
   */
  gitObserver?: GitObserver;
  /**
   * Override the worktree manager code dispatch cuts branches through (tests
   * inject `FakeWorktreeManager`). Without it a test's `repoRoot` defaults to
   * `process.cwd()`, so every dispatched code agent leaves a real branch behind
   * in the developer's own checkout — and on a CI `pull_request` checkout, where
   * there is no `main` ref to resolve a base against, `ensure` throws and the
   * dispatch is rejected instead.
   */
  worktrees?: Worktrees;
  /**
   * Override how an environment is asked whether it holds a commit (tests inject
   * `FakeEnvironmentProber`). Without it the real prober runs the operator's
   * configured shell command — which a test has none of, and which would spawn a
   * shell on the developer's machine if it did.
   */
  environmentProber?: EnvironmentProber;
  /** Override where recorded errors are mirrored (tests silence the default stderr echo). */
  errorMirror?: (entry: ErrorLogEntry) => void;
  /**
   * Override the config file the write route targets (tests point it at a temp
   * file). Without it a test that saves config rewrites the `lubbdubb.config.json`
   * of whatever checkout the suite is running in — see {@link System.configFile}.
   */
  configFile?: string;
  /**
   * Override the targeted project's shared config path (tests point it at a temp
   * file, or at one that does not exist) — see {@link System.projectConfigFile}.
   */
  projectConfigFile?: string;
  /**
   * Override how a report about LubbDubb itself is filed (tests inject
   * `FakeUpstreamIssues`). Without it the two collection-level issue routes spawn
   * the real `gh` against the real repository, which for a test is either a filed
   * issue somebody has to close or a failure that depends on whose machine ran it.
   */
  upstream?: UpstreamIssues;
  /**
   * Override when crash recovery considers this process to have started (tests).
   * Everything older is a previous run's orphan; everything newer is a dispatch
   * this run is in the middle of. Defaults to module load.
   */
  bootedAt?: string;
}

/**
 * The composition root. Wires every module together through its interface so any
 * one can be swapped — the tests build a System with a fake PTY backend and an
 * in-memory store, the server builds a real one, and nothing else changes.
 */
export function buildSystem(config: Config, opts: BuildOptions = {}): System {
  // The project name goes in at construction because every fact is stamped with it
  // as it is written, and because the one backfill the pool adds needs a name to
  // assert rather than guess (`stampFactsWithProject`).
  const store = new Store(config.dbPath, undefined, config.pool?.project);
  // Recorded MCP-call arguments past their retention, cleared at boot as well as
  // on the write path. The write path alone would be a retention promise kept
  // only while the fleet is busy: a harness that goes quiet holds its arguments
  // until something calls a tool again, which on a paused deployment is never.
  // `force`, because the write path's hourly rate limit is about a hot loop and
  // this runs once.
  store.compactMcpCallArgs(config.mcpArgsRetentionDays, true);
  // The world is assembled from the integrations config selects (default: the
  // fake provider for every capability), composed behind the Connector/ActionSink
  // seams the harness and executor depend on. Swapping a provider is a config
  // change; nothing here changes.
  const now = (): string => new Date().toISOString();
  // The one error-recording path: everything that catches a failure routes it
  // here so it's durable, mirrored to stderr, and streamed to the cockpit.
  const errors = new ErrorLog(store, opts.errorMirror);
  const integrations = buildIntegrations(config.integrations, { store, config, now, errors });
  const connector = new CompositeConnector(integrations, now);
  // The project's area tree, cached so the appraisal tool and the state snapshot can
  // both read it without awaiting. Refreshed from the pulse under its own TTL, and
  // null until the first read lands — which is the same reading a tracker with no
  // classification tree gives, and the right one: nothing offered, nothing asked.
  const areaPaths = new AreaPathDirectory(connector, { now: () => Date.now(), errors });
  const backend = opts.backend ?? new NodePtyBackend();

  // Live, in-memory dispatch controls both the harness and executor read by
  // reference each cycle. Ephemeral by design: a restart reverts to config. Built
  // here rather than beside its other consumers because the worktree pool's bound
  // reads the cap too — see below.
  const runtimeControl = new RuntimeControl(config.maxConcurrentAgents, config.startPaused);

  // Worktrees are a bounded pool of directories leased to branches, not one
  // directory per branch — so a dispatch lands in a tree that still has the last
  // occupant's ignored build state. `held` is the durable half of the lease: it is
  // what stops a slot being reissued under an agent a restart restored into it, and
  // what releases one the moment crash recovery settles the task behind it.
  const worktrees =
    opts.worktrees ??
    new WorktreeManager(
      config.repoRoot,
      config.worktreeRoot,
      {
        // A getter, so the bound is the *live* cap's — the same by-reference read
        // the harness's headroom does. The two are separate limits over one fleet
        // and the lower wins: read once at boot, a cap raised in the cockpit would
        // dispatch past the pool and be rejected for want of a directory forever,
        // which presents as a full queue and an idle fleet with nothing red.
        // The cap is the fleet's one size knob: the pool is sized off it and there
        // is nothing else to set.
        get size() {
          return defaultPoolSize(runtimeControl.cap);
        },
        held: (branch) => store.findActiveTaskByBranch(branch) !== null,
      },
      config.localRunRoot,
      errors,
    );
  // Branch reality for plan reconciliation — read-only, and the seam a test swaps
  // to script "has this part pushed" without a repo.
  const gitObserver = opts.gitObserver ?? new GitCliObserver(config.repoRoot);

  // Pick the agent runtime and how it's launched from the configured mode.
  // `claudeTui` marks the real interactive claude REPL, which needs two things
  // raw/mock sessions don't: its transcript read from the session file Claude
  // Code writes (the screen carries slash menus, hints and column-wrapped prose
  // that no chrome filter can undo), and an active exit-on-done — the REPL never
  // ends a session by itself, so without it the process and its worktree leak (#66).
  const sessionRoot = config.sessionTranscriptRoot ?? defaultSessionRoot();
  // How a stopped agent's *descendants* die with it (issue: a Bash-tool shell
  // outliving its agent pins the worktree cwd, and Windows then refuses rmdir on
  // it forever). See {@link ProcessReaper}.
  //
  // **The real reaper is wired only alongside the real transports.** It signals
  // whatever pid it is handed, and an injected `backend`/`streamSpawner` scripts a
  // process whose pid belongs to something else entirely on the host — so with a
  // fake in place the default must be, and is, a no-op. A test that wants to
  // observe the reap injects its own recorder.
  const realTransport = opts.backend === undefined && opts.streamSpawner === undefined;
  const reapTree: ProcessReaper =
    opts.reapProcessTree ??
    (realTransport
      ? (pid) => killProcessTree(pid, (message) => errors.record({ source: 'agent', message }))
      : () => {});
  const ptyFactory = (claudeTui: boolean): SessionFactory => {
    return (spec) =>
      new PtySession(backend, {
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        waitingPatterns: spec.waitingPatterns,
        submitDelayMs: config.agentSubmitDelayMs,
        // Needs a pinned session id to name the transcript file. Both real runtimes
        // now carry one, but only the TUI needs its screen read back out of a file —
        // stream mode builds its transcript from the events themselves.
        sessionTranscript:
          claudeTui && spec.sessionId
            ? { root: sessionRoot, sessionId: spec.sessionId, startAtEof: spec.resume === true }
            : undefined,
        onWarning: (message) => errors.record({ source: 'agent', message }),
        exitOnDone: claudeTui,
        // Real-TUI only: raw/mock sessions are line-oriented and legitimately
        // silent between steps, so idle means nothing there.
        idleWaitMs: claudeTui ? config.agentIdleWaitMs : 0,
        reap: reapTree,
      });
  };
  const streamFactory: SessionFactory = (spec) =>
    new StreamJsonSession(spec, opts.streamSpawner, reapTree, config.agentSilenceParkMs);

  // Brief attachments (issue #249): one canonical file per image under the
  // config'd root, outside every worktree. Every launch is granted read access to
  // that root, which is what makes the path in an agent's prompt openable.
  const attachments = new AttachmentFiles(config.attachmentRoot);
  // Validation resources ride alongside for the same reason and on the same
  // terms: a fixture is only useful to an agent that can open it, and the root is
  // outside every worktree precisely so it survives the reap. Granted whether or
  // not `validation.enabled` — the directory is the harness's own and empty on a
  // deployment that never writes one, and a grant that came and went with a policy
  // flag would make an agent's readable set depend on config it cannot see.
  const additionalDirectories = [config.attachmentRoot, config.validationRoot];

  const perm = config.agentPermissionMode;
  const extraArgs = config.claudeArgs;
  const allowedTools = config.agentAllowedTools;
  // The permission backstop's tool name (issue #130 phase B). Passed on every
  // launch; it only takes effect when that launch also carries an `--mcp-config`.
  const permissionPromptTool = PERMISSION_PROMPT_TOOL;
  // `mcpConfigPath` is per-launch (minted by AgentManager) and MUST be threaded
  // through — without it neither `--mcp-config` nor `--permission-prompt-tool` is
  // ever added, and the tool channel is dead in production.
  // `model` is per-launch for the same reason and with the same trap: it is the
  // task's own resolved model (issue #321), so a builder that accepts it and
  // forgets to forward it type-checks clean and silently drops the flag.

  // What the fleet knows, rendered (issue #27 phase 3). A **function**, read at
  // each launch rather than a value fixed at wiring time: a claim an operator
  // injected or demoted now must reach the next launch, not the next restart.
  // Recomputing an identical string per launch is free; producing a *different*
  // one would cost the fleet its cached prefix, which is why `renderKnowledgeBlock`
  // takes nothing per-dispatch.
  //
  // The store decides what is *reachable* — `askFacts` answers only from `lookup`
  // and `injected`, and never with a lapsed row — and the renderer decides which
  // of those ride the system prompt. Two rules, each stated once.
  //
  // This closure is the whole of what knows the knowledge base exists on the
  // launch path. `agentProtocol.ts` is handed the finished string and never sees
  // the store — `test/knowledge.test.ts` asserts structurally that it cannot.
  //
  // Every scope is read, not just `fleet`: since notices (phase 4) an injected
  // fact rides this block whatever its scope, and `renderKnowledgeBlock` is what
  // decides which — narrowing the *query* here would be a second opinion about
  // delivery, and the one that silently won.
  const knowledgeBlock = (): string =>
    renderKnowledgeBlock(store.askFacts({ limit: KNOWLEDGE_READ_LIMIT }), config.knowledgeBlockChars).text;

  type ArgsBuilder = (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    model: string | null;
    effort: string | null;
  }) => string[];
  const agentSetup = {
    stream: {
      // Resumable like the PTY runtime, and for the same reason: the id is pinned up
      // front so a restart can re-open *this* conversation. Headless `claude` honours
      // both flags (issue #318) — which is what puts `restore` on the recovery desk
      // for the default deployment instead of requeue-or-remove.
      buildArgs: (({ sessionId, resume, mcpConfigPath, model, effort }) =>
        buildClaudeStreamArgs({
          permissionMode: perm,
          extraArgs,
          allowedTools,
          additionalDirectories,
          sessionId,
          resume,
          fileEvents: true,
          mcpConfigPath,
          permissionPromptTool,
          model: model ?? undefined,
          effort: effort ?? undefined,
          knowledgeBlock: knowledgeBlock(),
        })) as ArgsBuilder,
      factory: streamFactory,
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      resumeInput: buildResumeMessage,
      promptDelayMs: 0, // stdin is ready immediately; no TUI to wait for
      resumable: true,
    },
    pty: {
      // Pin the session id up front, `--resume` it later.
      buildArgs: (({ sessionId, resume, mcpConfigPath, model, effort }) =>
        buildClaudeArgs({
          permissionMode: perm,
          extraArgs,
          allowedTools,
          additionalDirectories,
          sessionId,
          resume,
          statusLine: true,
          fileEvents: true,
          mcpConfigPath,
          permissionPromptTool,
          model: model ?? undefined,
          effort: effort ?? undefined,
          knowledgeBlock: knowledgeBlock(),
        })) as ArgsBuilder,
      factory: ptyFactory(true),
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      resumeInput: buildResumeMessage,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: true,
    },
    raw: {
      // Deliberately ignores `model`: running the operator's argv verbatim is this
      // mode's whole contract, and it speaks no protocol to assign work by.
      buildArgs: (() => config.claudeArgs) as ArgsBuilder,
      factory: ptyFactory(false),
      initialInput: undefined,
      resumeInput: undefined,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: false,
    },
  }[config.agentMode];

  // PTY-only: capture the status-line payloads (the one surface carrying the
  // account 5h/weekly limits) into per-session files under the OS tmpdir — a
  // stable spot so the last known limits survive a restart.
  const rateLimits = config.agentMode === 'pty' ? new StatusFileRateLimits(join(tmpdir(), 'lubbdubb', 'status')) : null;

  // File-events capture (the PostToolUse hook's spool): one dir per agent under
  // the OS tmpdir. Wired for every mode — the hook itself is only injected for
  // the real runtimes (stream/pty), so mock/raw agents just leave it empty.
  const fileEvents = new FileEventsSpool(join(tmpdir(), 'lubbdubb', 'events'));

  // The typed channel back to the harness (issue #108). Constructed unconditionally
  // so `system.mcp` is always addressable, but only handed to the fleet when the
  // operator leaves it on — and it still needs `listen()` (the server's boot does
  // that) before any launch actually gets a `--mcp-config`. The `agents` thunk is
  // the mutual reference: a launch needs a credential, a tool call needs the fleet.
  // Both sides annotated so the mutual reference stays a *runtime* cycle and not
  // an inference one — TS can't infer either type from the other.
  const mcp: McpBridgeServer = new McpBridgeServer({
    store,
    agents: (): AgentManager => agents,
    argsRetentionDays: config.mcpArgsRetentionDays,
    configDir: defaultConfigDir(),
    socketPath: defaultSocketPath(),
    // What the appraiser is offered when it proposes a profile for a goal.
    profiles: orderedProfiles(config.agentModels),
    // What the appraiser is offered when it proposes where a goal belongs. A thunk
    // rather than a snapshot: the directory refreshes on the pulse, and a list
    // captured here would pin every agent to the tree as it stood at boot.
    areaPaths: (): AreaPathTree | null => areaPaths.current(),
    // Lazy for the same reason as `agents`: the desk is built after this server
    // (it needs the escalation inbox).
    permissions: (): PermissionDesk => permissions,
    // Lazy for the same reason again: the sink and the template book are both built
    // below this. If this closure is ever dropped, `open_pr` reports itself unwired
    // in production and no test catches it — the ArgsBuilder/mcpConfigPath trap.
    openPr: (): McpToolDeps['openPr'] => ({
      sink: opts.sink ?? connector,
      defaultBranch: config.defaultBranch,
      prompts,
      // So the pull request the tool opens is watched the moment it exists, rather
      // than on the next pulse — the fleet's own work is never briefly invisible
      // to the fleet.
      watchLabel,
      // So the body guidance names the sigil this provider reads as "pull
      // request" — `#12` is work item 12 on Azure, and a stacked part naming its
      // base pull request that way links to an unrelated ticket.
      prRefStyle: prRefStyle(config.integrations.sourceControl),
    }),
    // Lazy for the same reason: `link_ticket` files the item an agent wrote up
    // (issue #394), and the sink it files through is built below.
    filing: (): McpToolDeps['filing'] => filing,
    // Lazy for the same reason again: the executor is built below this. It is
    // where `reply_to_review` hands an agent's reply, so the reply takes the same
    // route a rule-drafted one takes — held, authorized and signed — instead of
    // being posted from inside the agent with the operator's credential.
    prReply: (): McpToolDeps['prReply'] => executor,
    errors,
  });

  // Hoisted out of the RuleDispatcher's construction because the template book is
  // no longer only the dispatcher's: `POST /api/findings/:id/file` renders
  // `finding-ticket` from it, and the desktop channel below renders `local-run`,
  // both of which must work whether or not a cycle is running.
  const prompts = loadPromptTemplates(config.promptTemplatesDir);

  // The project's review charter, on the same terms as the template book above:
  // read once, from the checkout rather than from any branch, and absent where
  // the project names no file. A path that names nothing is recorded rather than
  // swallowed — a team whose charter is not being read has no other way to find
  // out.
  const reviewCharter = loadReviewCharter(config.repoRoot, config.review.charterFile, (error, path) =>
    errors.record({
      source: 'boot',
      message: `Review charter "${path}" could not be read; the reviewer runs without it.`,
      detail: error instanceof Error ? error.message : String(error),
    }),
  );

  // The desktop channel (the operator's own Claude Code). Constructed
  // unconditionally so `system.desktop` is addressable, and inert until
  // `listen()` — which is the only thing that binds the stable socket or writes
  // a credential into the operator's home directory. `main.ts` calls it on every
  // boot; keeping the footprint in `listen()` rather than in the constructor is
  // what keeps a test's system from writing into whoever is running the suite.
  const desktop = new McpDesktopServer({
    store,
    argsRetentionDays: config.mcpArgsRetentionDays,
    claimMinutes: config.validation.desktopClaimMinutes,
    validationRoot: config.validationRoot,
    // `goal_read` answers "has it reached hallway yet" off the operator's own list.
    environments: config.environments,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    // Lazily, for `proposals`' reason: the runner is built further down, and both
    // this channel and the cockpit's panel must start *the same* run.
    localRun: (): LocalRunner => localRun,
    // Lazy for the fleet deps' reason a few lines above: `plan_amend` withdraws
    // the superseded approval card and puts the fresh one up, and both the desk
    // and the harness are built below this.
    proposals: () => proposals,
    runCycle: () => harness.runCycle('manual').then(() => undefined),
    now: () => new Date().toISOString(),
    socketPath: config.validation.desktopSocketPath,
    credentialPath: config.validation.desktopCredentialPath,
    errors,
  });

  // What a Feature summary is gathered and digested with, or null where this
  // deployment has no feature board — the same `featureBoardOn` conjunction the
  // route refuses on and the cockpit draws its tab off, asked once here so the
  // rule, the dossier and the key an agent's submission is stamped with cannot
  // come to three different answers about whether the feature exists at all.
  const featureBoard = featureBoardOn(config, connector)
    ? {
        containerTypes: config.issueContainerTypes,
        watchLabel: watchLabelFor(config.labelPrefix),
        environments: config.environments,
      }
    : null;

  const agents: AgentManager = new AgentManager(store, {
    command: config.claudeCommand,
    buildArgs: agentSetup.buildArgs,
    whitelistedApprovals: config.whitelistedApprovals,
    // What a goal's work runs on today, so `recordAppraisal` can tell an agreeing
    // proposal from a diverging one. Read off the world baseline rather than a
    // live provider call: it is the same snapshot `world_read` serves an agent,
    // so the appraiser and the harness are comparing against one reading. Absent
    // when either half of a pin is unconfigured, and then no proposal is stored.
    goalProfile:
      config.labelPrefix && config.agentModels
        ? {
            effective: (issueOrigin: string): string | null => {
              const models = config.agentModels;
              const number = Number(/^issue:(\d+)$/.exec(issueOrigin)?.[1]);
              const issue = Number.isFinite(number)
                ? store.getWorldBaseline()?.issues.find((i) => i.number === number)
                : undefined;
              return resolveModelTag(issue?.labels, config.labelPrefix, models).profile ?? models?.default ?? null;
            },
          }
        : undefined,
    // Where a Feature's children stand at the moment a summary lands — read here
    // and never at dispatch, or anything that moved during the run would match the
    // stored key for ever and the Feature would never be summarised again.
    featureStanding: featureBoard
      ? (featureOrigin: string): string | null =>
          featureRecords(store, featureBoard).find((f) => `issue:${f.number}` === featureOrigin)?.key ?? null
      : undefined,
    createSession: agentSetup.factory,
    initialInput: agentSetup.initialInput,
    resumeInput: agentSetup.resumeInput,
    promptDelayMs: agentSetup.promptDelayMs,
    waitingPatterns: config.agentWaitingPatterns,
    stallNudges: config.agentStallNudges,
    stallParkMs: config.agentStallParkMs,
    stallExtendMs: config.agentStallExtendMs,
    silenceParkMs: config.agentSilenceParkMs,
    resumable: agentSetup.resumable,
    resumeAttempts: config.agentResumeAttempts,
    statusFile: rateLimits ? (sessionId): string => rateLimits.fileFor(sessionId) : undefined,
    fileEvents,
    docsFolderPrefix: config.docsFolderPrefix,
    mcp,
    // The `plan.json` transport's half of the approval gate — the tool transport
    // gets the same flag above, so a verdict lands identically either way.
    errors,
  });
  const escalations = new EscalationInbox(store, agents);
  // The permission backstop (issue #130 phase B): where an agent's un-allowlisted
  // tool call blocks until the operator allows or denies. Reaches the fleet via the
  // MCP server's `permissions` thunk above; resolved on agent death via its `release`.
  const permissions = new PermissionDesk(escalations);
  // Where a restart's orphaned agents wait for a verdict. `resumable` is the same
  // runtime fact `AgentManager` uses, threaded in so the desk can say *why* restore
  // isn't on offer rather than the cockpit guessing from a missing session id.
  const recovery = new RecoveryDesk({
    store,
    agents,
    escalations,
    resumable: agentSetup.resumable,
    // The fence on the agentless arm. A test that wants a task read as an orphan of
    // a previous run sets this ahead of the rows it built; production takes the
    // module-load default.
    bootedAt: opts.bootedAt,
    errors,
  });

  // Recorded before the executor, which asks it whether a rung's merge is already
  // authorized. It reaches nothing but the store and the inbox, so the two are
  // wired one way and there is no cycle to break.
  const landings = new StackLandingDesk(store, escalations, errors);

  const executor = new ActionExecutor({
    store,
    landings,
    agents,
    worktrees,
    escalations,
    sink: opts.sink ?? connector,
    agentModels: config.agentModels,
    deskRoot: config.deskRoot,
    defaultBranch: config.defaultBranch,
    runtime: runtimeControl,
    errors,
    // Read through the running config object, never copied: the key is
    // live-applied, and the flip that matters is the one turning it back off.
    autoSendReplies: () => config.sendPrRepliesWithoutApproval,
    // The composite, never `opts.sink`: this is a *read* of the provider, and a
    // test that swaps the outbound sink is not saying anything about where CI
    // evidence comes from. It answers `[]` when no integration can supply any,
    // so the fake provider composes exactly the prompt it always did.
    ciEvidence: opts.ciEvidence ?? connector,
    // How an agent amends a goal's ticket, so a standing operator instruction
    // that changes what the goal asks for can reach the record everyone else
    // reads. Config, resolved per issue — null under the fake provider, where the
    // note says there is nothing to update rather than naming a failing command.
    instructionTracker: (issueNumber) => ticketAmendCommands(config, issueNumber),
    // Absent where there is no feature board, which is also where nothing
    // dispatches a summariser — one conjunction, asked once, above.
    featureBoard: featureBoard ?? undefined,
  });

  // The accept/reject surface for every act the harness will not perform on its
  // own — which is all of them. It runs an accepted act through the executor, so
  // the outbound sink keeps a single caller and the human's authorization lands in
  // the audit log.
  const proposals = new ProposalDesk(store, escalations, executor, {
    // The same sink an accepted act runs through, so the back-out's comment and
    // close are the one outbound seam rather than a second route to the tracker.
    sink: opts.sink ?? connector,
    config,
    errors,
  });

  // Dispatcher-level issue-pickup policy (gate + label-encoded priority), honoured
  // by whichever dispatcher is selected — provider-agnostic.
  const watchLabel = watchLabelFor(config.labelPrefix);
  const issuePickup: IssuePickupPolicy = {
    watchLabel,
    // The ownership gate needs both halves of the identity split: a project that
    // wants filtering (`ownWorkOnly`) and somebody to filter to (`userId`). Either
    // missing — the fake provider, a first run, a team that works each other's
    // queue — and any tagger counts.
    requireOwnLabel: config.ownWorkOnly && config.userId !== undefined,
    priorityLabels: config.issuePriorityLabels,
    defaultPriority: config.issueDefaultPriority,
    pickupStates: config.issuePickupStates,
    inReviewState: config.issueInReviewState,
    inProgressState: config.issueInProgressState,
    containerTypes: config.issueContainerTypes,
  };
  const rules = new RuleDispatcher(
    issuePickup,
    {},
    prompts,
    config.defaultBranch,
    config.planning,
    config.ci,
    config.validation,
    config.validationRoot,
    prRefStyle(config.integrations.sourceControl),
    config.review,
    reviewCharter,
  );
  const dispatcher: Dispatcher = rules;

  // What a config change does to *this* process — the live keys' arms and the
  // pending list behind them. Wired here because an arm reaches components only
  // the composition root holds; a save from the cockpit and an edit to the file
  // both land on it, which is what keeps the two from behaving differently.
  const liveConfig = new LiveConfig({ running: config, runtimeControl, dispatcher: rules });

  // The store holds scheduling intent; this folds git + provider reality back onto
  // it every pulse. Its `git fetch` is wired only for the real observer: the seam
  // is fetch-free by design, so refreshing the remote is the caller's call (floored
  // by `planning.gitFetchIntervalMs` so a fast heartbeat can't storm the remote).
  const plans = new PlanReconciler({
    store,
    git: gitObserver,
    sink: opts.sink ?? connector,
    planning: config.planning,
    defaultBranch: config.defaultBranch,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    fetch: opts.gitObserver ? undefined : () => fetchRemote(config.repoRoot),
    errors,
  });

  // The goal appraisal's outbound half: one living comment per refused goal, on the
  // ticket. Beside the plan reconciler because it is the same act — mechanical
  // bookkeeping through the same seam, not an action the executor gates.
  const appraisals = new AppraisalDesk({ store, sink: opts.sink ?? connector, errors });
  // The naming convention's outbound half, and it asks whether the world *arrives*
  // filtered rather than who the operator is: both providers apply the author
  // filter at fetch time, and only while `ownWorkOnly` is on. With it off the
  // harness sees everyone's pull requests, so it may not assume one is its own.
  const prAuthorConfigured = config.ownWorkOnly && config.userId !== undefined;
  const naming = new PrNamingDesk({
    sink: opts.sink ?? connector,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    template: prompts.render('pr-title', {}),
    errors,
  });
  // The other half of tidying up after a pull request: once it has merged, the
  // branch behind it goes — worktree, local ref, then the remote. Only ever the
  // operator's own pull requests, and never a branch another open PR still targets.
  // The harness's own pull requests, tagged as watched so the fleet keeps working
  // what it opened. `open_pr` tags one as it creates it; this is the floor under
  // that — an agent that opened its own, a code job's, and everything already open
  // the first pulse a deployment runs it. Once per pull request, so an operator's
  // un-watch is never written back over.
  const prWatch = new PrWatchDesk({
    sink: opts.sink ?? connector,
    store,
    watchLabel,
    // The retired tag, read here and nowhere else: seeding is the one path that
    // could put the fleet back on a pull request somebody explicitly parked.
    legacyIgnoreLabel: config.labelPrefix ? `${config.labelPrefix}-ignore` : '',
    errors,
  });

  // The other thing a pull request owes the moment it exists: the work item it was
  // opened for, linked on the tracker rather than named in prose. Azure's "check for
  // linked work items" policy blocks a pull request without one, and the harness has
  // known the number since pickup — so this is a row read, not an agent. `open_pr`
  // links one as it creates it; this is the floor under that, on the same terms as
  // the watch seeding beside it.
  const prWorkItems = new PrWorkItemDesk({
    sink: opts.sink ?? connector,
    store,
    prAuthorConfigured,
    errors,
  });

  const branchReaps = new BranchReapDesk({
    sink: opts.sink ?? connector,
    store,
    worktrees,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    errors,
  });

  // Where a goal's landed work has got to. The prober is the operator's own
  // command, so the desk is built whether or not any environment is configured:
  // the attribution half has to run regardless, because a merge SHA is only on
  // offer while its pull request is inside `closedPrWindowMs` and is unrecoverable
  // afterwards — a deployment that configures its first environment later still
  // wants today's landings on record when it does.
  const environments = new EnvironmentDesk({
    store,
    environments: config.environments,
    prober: opts.environmentProber ?? new CommandEnvironmentProber(config.repoRoot),
    // The clone answers "is this landing in what the environment named", which is
    // what keeps the probe to one spawn per environment however many goals are in
    // flight. The same observer the plan reconciler fetches for, so the objects
    // this asks about are as fresh as `planning.gitFetchIntervalMs`.
    git: gitObserver,
    sink: opts.sink ?? connector,
    probeIntervalMs: config.environmentProbeIntervalMs,
    errors,
  });

  // The step after the launch, and the one station on the floor a person staffs:
  // a delivered goal whose ticket is still open owes a close. Store-only — it
  // files and settles a `human_tasks` row and touches no sink, because closing
  // the item is precisely the part the harness is not doing.
  // The one thing it asks the outside world, and it asks it about the *row's
  // wording*: whether the close the row is about can be taken from the cockpit.
  const closeOutSink = opts.sink ?? connector;
  const closeOuts = new DeliveryCloseOutDesk(store, config.environments, () => closeOutSink.canCloseIssue());

  // The other ask a delivered goal owes: the fixtures and accounts its validation
  // plan could not produce. Store-only on the close-out desk's terms, and gated on
  // the same delivery — a resource is what makes a check runnable, and nothing
  // runs a check before the goal is delivered.
  const validationAsks = new ValidationAskDesk(store);

  // The moment the checks become somebody's to run. Store-only on the close-out
  // desk's terms and gated on the same delivery — and beside it deliberately: a
  // goal is delivered, and the two things it then owes a person are a close and a
  // validation.
  const validationReady = new ValidationReadyDesk(store, config.environments);

  // The one cost reading taken while the money is still being spent. Store-only
  // for the close-out desk's reason and one more: an expensive run is not a wrong
  // run, so the verdict is a visible obligation and never a kill.
  const burn = new SpendBurnDesk(store, config.spendBurn);

  // The other reading taken while nothing is wrong: whether there is anything
  // left for the fleet to do. Store-only on the burn watch's terms — it files a
  // visible obligation and settles it when the queue recovers, and it is the one
  // desk whose subject is the *pipeline* rather than a piece of work in it.
  const runway = new RunwayDesk(store, config.runway);

  // Where a recurrence becomes a queued job. Store-only, like the close-out desk:
  // it writes the same `jobs` row the launch route writes and leaves every
  // question about what happens to it to rule `manual-job`.
  const schedules = new ScheduleDesk({ store, errors });

  // The harness watching its own build. Store-and-flag only: it takes a reading,
  // and a drain writes the same `paused` flag the operator's own pause writes. The
  // repo it reads is resolved from this module's own path, never `config.repoRoot`
  // — see `src/selfUpdate/buildStanding.ts` for why those are different questions.
  const updates = new UpdateDesk({
    store,
    runtimeControl,
    errors,
    remote: config.selfUpdate.remote,
    branch: config.selfUpdate.branch,
    checkIntervalMs: config.selfUpdate.checkIntervalMs,
  });

  // How the harness files a tracker item: three of the four filing arms call this
  // straight from their route, and `link_ticket` calls it for the two that still
  // have an agent writing the words (issue #394).
  const filing = ticketFiler(config, opts.sink ?? connector);
  // Not `opts.sink`, and not the connector at all: a fault in the cockpit belongs on
  // the cockpit's tracker whatever the fleet is pointed at (issue #449).
  const upstream = opts.upstream ?? ghCliUpstreamIssues();
  const graph = new WorkGraphRecorder({ store, errors });

  // The ticket mirror's keeper: one month of backfill on a fresh database, then an
  // incremental changed-since read every pulse. A record, not a decision — nothing
  // under `src/dispatcher/` reads it, and the tab it feeds is a lens.
  const tickets = new TicketSweep({ store, source: connector, errors });

  // What the harness has seen for itself, written down where the fleet reads it
  // (issue #27 phase 4). Always wired: with nothing to report it writes nothing,
  // and there is no configuration under which the fleet is better off paying twice
  // to rediscover a flake the pulse already watched happen.
  const notices = new KnowledgeNoticeDesk({ store, errors });

  // What became of the documentation work an operator opened for a claim (issue
  // #27 phase 6). Always wired, like the notices above: with no graduation in
  // flight it reads nothing, and a deployment without it is one where a landed
  // pull request never takes its claim out of the fleet's prompts.
  const graduations = new KnowledgeGraduationDesk({ store, errors });

  // Which proposals look like one claim written twice (issue #27). Always wired,
  // like the two desks above: it writes suggestions nobody is bound by, on a clock
  // of its own rather than every pulse, and a deployment without it is one where
  // two agents who hit one wall in their own words each file a singleton nothing
  // will ever carry.
  const clusters = new KnowledgeClusterDesk({ store, errors });

  // The distance above `fleet` (issue #28): what this fleet has vouched for, carried
  // to the others, and a daily digest of what it spent. Wired **only when the pool
  // is selected** — unlike the two desks above, which are always on: with
  // `integrations.pool` at its `fake` default there is nothing to publish to and
  // nothing to read, so a desk here would be a pass that runs every pulse to write
  // an in-memory map nobody reads.
  //
  // The coordinates are read straight from config because `validatePool` has already
  // refused a boot without them — the reads below are the type's, not a second gate.
  //
  // **`fleetId` is the exception, and it is a gate.** It is not refused at load, so
  // that a deployment which selects the pool before naming its fleet boots and is
  // asked on **Needs you** rather than in a terminal — and an unnamed fleet must
  // therefore publish nothing at all. `?? ''` below would make its address
  // `fleets//claims.json`, which every other fleet in the pool reads as a document
  // with no author, so the desk sits out entirely until the row is answered.
  // → `docs/spec/28-cross-fleet-pool.md#a-fleet-with-no-name-yet`
  const fleetId = config.fleetId ?? '';
  const pool =
    config.integrations.pool === 'fake' || fleetId === ''
      ? undefined
      : new PoolDesk({
          store,
          transport: buildPoolTransport(config.integrations, { store, config, now, errors }),
          fleetId,
          project: config.pool?.project ?? '',
          harnessVersion: harnessVersion(),
          now,
          digestIntervalMs: config.pool?.digestIntervalMs ?? 60 * 60 * 1000,
          errors,
        });

  const harness = new Harness({
    store,
    connector,
    dispatcher,
    executor,
    // Empty on a deployment with no feature board, and then the pulse does no
    // mirror read at all — the gather is several full-table reads.
    featureStandings: featureBoard
      ? (): { number: number; title: string; key: string }[] =>
          featureRecords(store, featureBoard).map((f) => ({ number: f.number, title: f.title, key: f.key }))
      : undefined,
    plans,
    appraisals,
    areaPaths,
    naming,
    closeOuts,
    validationAsks,
    validationReady,
    burn,
    runway,
    // The gate the runway watch reads supply through — the same policy object the
    // dispatcher carries, so the lens and rule `issue-pickup` cannot come to
    // different answers about one issue.
    issuePickup,
    branchReaps,
    environments,
    prWatch,
    prWorkItems,
    schedules,
    // Only when the watch is on: absent, the pulse takes no reading and the gauge
    // reads unknown, which is the behaviour of every deployment before this existed.
    updates: config.selfUpdate.enabled ? updates : undefined,
    graph,
    tickets,
    landings,
    // Holds the pulse while a previous run's agents await a verdict.
    recovery,
    // Sweeps "Needs you" items whose agent has died, whatever route it died by.
    escalations,
    // Resumes the agents parked on a usage limit whose window has turned over.
    fleet: agents,
    notices,
    graduations,
    clusters,
    pool,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    errors,
    runtime: runtimeControl,
    prWatchLabel: watchLabel,
    // Only when both halves exist: pins are labels naming profiles, so a
    // deployment with no `labelPrefix` has nowhere to write one and a deployment
    // with no `agentModels` has nothing for one to name.
    modelPins:
      config.labelPrefix && config.agentModels
        ? { labelPrefix: config.labelPrefix, models: config.agentModels }
        : undefined,
    upNextOverrideTtlMs: config.upNextOverrideTtlMs,
  });

  // Auto-escalate any non-whitelisted waiting agent so it surfaces in the inbox.
  // Idempotent per agent: an agent already has at most one open escalation, so a
  // repeat 'waiting' (e.g. a resumed agent re-surfacing its park) never doubles up.
  // Enrich with the task's originating signal and a tail of the agent's output so
  // the human can answer from the card without opening the drawer for context.
  //
  // `ask` is present only when the park came through the `escalate` tool, which is
  // the whole point of that tool: the *type* and the answer options are things the
  // agent knows and the WAITING sentinel had no way to say. Absent, this behaves
  // exactly as it did — one free-text question filed as `answer_question`.
  agents.on('waiting', ({ agentId, taskId, reason, ask }) => {
    if (store.listOpenEscalations().some((e) => e.agentId === agentId)) return;
    const task = store.getTask(taskId);
    escalations.create({
      type: escalationTypeForAsk(ask?.kind),
      prompt: reason,
      context: {
        taskTitle: task?.title,
        originRef: task?.originRef ?? null,
        recentOutput: recentOutputExcerpt(store.getTranscript(agentId)),
        ...(ask?.options ? { options: ask.options } : {}),
        ...(ask?.detail ? { detail: ask.detail } : {}),
        ...(ask?.questions ? { questions: ask.questions } : {}),
      },
      agentId,
      taskId,
    });
  });

  // A dead agent can never receive an answer, so cascade-dismiss its open
  // escalations at every terminal-dead transition. Kill surfaces as a `killed`
  // status; every other ending surfaces as a `done` event, whichever of the two
  // statuses it carries and whoever declared it — an agent that finished with a
  // question of its own still open is the same un-answerable card as one that
  // crashed with it. (An agent orphaned by a *restart* is not dismissed here on
  // purpose: it may be restored, and a restored agent must come back to the
  // question it parked on — see `RecoveryDesk`, where the dismissal hangs off the
  // requeue/remove verdicts.)
  //
  // These two are the fast path only. The pulse sweeps the same set through
  // `EscalationInbox.tidyDeadAgents`, so a death that reaches neither listener is
  // still tidied within a heartbeat.
  agents.on('status', ({ agentId, status }) => {
    if (status === 'killed') escalations.dismissEscalationsForAgent(agentId, 'agent killed');
  });
  agents.on('done', ({ agentId, status, by }) => {
    escalations.dismissEscalationsForAgent(
      agentId,
      status === 'failed'
        ? 'agent failed'
        : by === 'operator'
          ? 'operator marked the work complete'
          : by === 'expiry'
            ? 'nobody answered the stop, so the harness recorded the work complete'
            : 'agent finished its work',
    );
  });

  // A code agent's worktree slot is released once its process has actually exited
  // ('reaped'), and nothing is deleted: the slot keeps its checkout and everything
  // git ignores in it for whichever branch is handed it next, and a failed or killed
  // agent's tree stays readable until then. The rendezvous on the exit is still
  // load-bearing — a live process is sitting in that directory, and the next
  // occupant cleans and switches it.
  //
  // **Every status, not just `done`.** Nothing else releases a lease, so skipping
  // the failed and killed ones would shrink the pool by one per failure with nothing
  // to say so. Slots are shared per-branch, so hands off while any sibling task on
  // the branch is still active.
  agents.on('reaped', ({ taskId }) => {
    const task = store.getTask(taskId);
    const branch = task?.branch;
    if (!branch) return;
    const active = (s: string): boolean => s === 'queued' || s === 'running' || s === 'waiting';
    if (store.listTasks().some((t) => t.id !== taskId && t.branch === branch && active(t.status))) return;
    void worktrees.remove(branch).catch((err: Error) => {
      errors.record({ source: 'agent', message: `Failed to release the worktree slot for ${branch}: ${err.message}` });
    });
  });

  // The vivarium reads what the operator has already done and writes only its own
  // five tables. Wired to the pulse's own event rather than into `Harness` — it
  // decides nothing, so `harness.ts` has no reason to know it exists, and the
  // pulse does not wait on it. The routes that settle an operator action call
  // `scan()` too, for latency; this is what guarantees delivery.
  const pets = new PetKeeper(store, config.pets);
  harness.on('cycle:end', () => {
    try {
      pets.scan();
    } catch (err) {
      errors.record({ source: 'cycle', message: `Pet scan failed: ${(err as Error).message}` });
    }
  });

  // The machine's one dev environment. Constructed unconditionally — with no
  // `localRun.instruction` every start refuses with that as its reason, which is a
  // surface that says why rather than one that is quietly absent.
  const localRun = new LocalRunner({
    store,
    worktrees,
    // The same factory the fleet's agents come from, already narrowed by
    // `agentMode` — so a test's fake runtime holds the environment up too, and this
    // module never learns that a real `claude` exists.
    sessions: agentSetup.factory,
    // By reference, so an instruction corrected in the cockpit reaches the next
    // start: `LIVE_ARMS` assigns a new object onto the running config.
    policy: () => config.localRun,
    claudeCommand: config.claudeCommand,
    claudeArgs: config.claudeArgs,
    permissionMode: config.agentPermissionMode,
    defaultBranch: config.defaultBranch,
    choicesFor: (originRef) => {
      const plan = store.getPlanByOrigin(originRef);
      // The goal's own branch as well as its parts', through the same
      // `openPrForIssue` the pickup verdict uses: a goal nobody decomposed has its
      // work on one pull request, and it is the whole answer for that goal. Read off
      // the baseline rather than the provider, like everything else that asks the
      // world a question outside a pulse.
      const number = planIssueNumber(originRef);
      const world = store.getWorldBaseline();
      const issue = number === null ? undefined : world?.issues.find((i) => i.number === number);
      const own = issue ? (openPrForIssue(issue, world?.pullRequests ?? [])?.branch ?? null) : null;
      return localRunChoices(plan ? store.listPlanParts(plan.id) : [], own);
    },
    reap: reapTree,
    errors,
  });
  // A row saying `running` after a restart describes a process this harness never
  // spawned, so nothing may go on trusting it — but the machine it left behind is
  // half an environment rather than none, and what happens to both is
  // `LocalRunner.resumeInterrupted`. It is called from `main.ts` rather than here
  // because it can spawn a session, and everything that can is below that file's
  // shutdown handlers. → docs/spec/23-local-runs.md
  return {
    config,
    store,
    connector,
    agents,
    escalations,
    proposals,
    landings,
    permissions,
    areaPaths,
    recovery,
    executor,
    dispatcher,
    harness,
    graph,
    tickets,
    pool,
    filing,
    upstream,
    updates,
    runtimeControl,
    pets,
    localRun,
    liveConfig,
    configFile: opts.configFile ?? configFilePath(),
    projectConfigFile: opts.projectConfigFile ?? projectConfigFilePath(config.repoRoot),
    issuePickup,
    prompts,
    rateLimits,
    fileEvents,
    attachments,
    mcp,
    desktop,
    worktrees,
    errors,
  };
}
