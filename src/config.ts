import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { IntegrationSelection } from './integrations/integration.js';
import { DEFAULT_CONTAINER_TYPES, DEFAULT_PARENTED_TYPES } from './issueRelations.js';
import { DEFAULT_PLANNING, type PlanningPolicy } from './plans/planning.js';
import { DEFAULT_BURN, validateBurnPolicy, type BurnPolicy } from './spendBurn.js';
import { DEFAULT_RUNWAY, validateRunwayPolicy, type RunwayPolicy } from './supply/runway.js';
import type { SelfUpdatePolicy } from './selfUpdate/upgradePlan.js';
import { DEFAULT_VALIDATION, type ValidationPolicy } from './validation/policy.js';
import { DEFAULT_PR_REVIEW, type PrReviewPolicy } from './review/policy.js';
import { DEFAULT_LOCAL_RUN, type LocalRunPolicy } from './localRun/policy.js';
import { DEFAULT_LOCAL_VALIDATION, type LocalValidationPolicy } from './localValidation/policy.js';
import { validateCiPolicy, type CiPolicy } from './ci/ciPolicy.js';
import { validatePolicyCheckModes, type PolicyCheckModes } from './integrations/azure/policyKinds.js';
import { validateAgentModels, type AgentModels } from './agents/modelPolicy.js';
import { DEFAULT_FILING_TYPES } from './ticketTypes.js';
import { DEFAULT_MCP_ARGS_RETENTION_DAYS } from './store/mcpCalls.js';
import type { PetPolicy } from './pets/keeper.js';
import { validateEnvironments, type EnvironmentConfig } from './environments/policy.js';
import { DEFAULT_READ_LANES } from './world/readPlan.js';
import type { IssueSequencing } from './sequence/readiness.js';
import { DEFAULT_SEQUENCE_MAX_CHILDREN } from './sequence/sequence.js';

/**
 * Central configuration. Everything the operator can tune lives here.
 * Values come from (in order of precedence): explicit overrides, a
 * `lubbdubb.config.json` file at the repo root, then these defaults.
 */
export interface Config {
  /**
   * How often the heartbeat fires a dispatch cycle while the fleet is doing something.
   * The near-real-time half of the cadence; {@link idleHeartbeatIntervalMs} is the other.
   * → `docs/spec/04-harness-cycle.md#the-adaptive-cadence`
   */
  heartbeatIntervalMs: number;
  /**
   * How often the heartbeat fires when nothing is moving. Never shorter than
   * {@link heartbeatIntervalMs}: a value below it is read as equal to it.
   */
  idleHeartbeatIntervalMs: number;
  /**
   * How long a "hot" entity's hydration may be reused while its change token sits still —
   * the backstop for fields no token covers. Hot means something is plausibly moving (a
   * build in flight, an open dispatch, a recent transition). → `docs/spec/04-harness-cycle.md#hot-and-cold`
   */
  hotReadMaxAgeMs: number;
  /**
   * The same bound for everything else — the slow lane. A cold entity is not invisible:
   * it is listed and its cheap fields refreshed every pulse; only per-entity fan-out is throttled.
   */
  coldReadMaxAgeMs: number;
  /** Hard cap on concurrently-running agents. Runtime-adjustable via the control endpoint. */
  maxConcurrentAgents: number;
  /**
   * Boot in a paused state (no new agents dispatched until resumed). Off by default. The
   * only config-level pause knob — live pause/resume is runtime-only and reverts on restart.
   */
  startPaused: boolean;
  /**
   * Send a review reply the fleet drafted without asking first. On by default (opt-out);
   * `false` makes every draft wait as a proposal. Replies only, and can only ever accept —
   * a rejection already given still governs. → `docs/spec/09-execution.md`
   */
  sendPrRepliesWithoutApproval: boolean;
  /** PTY prompt substrings the harness may auto-answer instead of escalating. */
  whitelistedApprovals: WhitelistRule[];
  /**
   * Who *you* are, to every provider the harness talks to. Drives attribution (tickets
   * assigned to you, branches named as yours); whether to *filter* by it is
   * {@link Config.ownWorkOnly}. Unset, filed tickets go unassigned regardless of
   * `ownWorkOnly`. Optional so the shipped mock stays bootable; a real deployment gets an
   * outstanding check instead (`src/setup/reading.ts`). → `docs/spec/26-setup.md`
   */
  userId?: string;
  /**
   * Whether the world arrives filtered to you — pickup counting only a watch tag you
   * added, and only PRs you opened or were assigned surfaced. Separate from
   * {@link Config.userId}: identity is personal, filtering is a team decision in
   * `lubbdubb.project.json`. Defaults to `true`. Assignment and branch naming do not read
   * this. → `docs/spec/07-pull-requests.md#a-pull-request-a-person-put-on-you`, `docs/spec/02-configuration.md#userid`
   */
  ownWorkOnly: boolean;
  /**
   * Which provider fulfils each integration capability. Defaults to the built-in `fake`
   * provider for every capability.
   */
  integrations: IntegrationSelection;
  /**
   * Who this fleet is in the cross-fleet pool. Explicit and never derived (`alice@acme-api`)
   * so two of one person's deployments are distinguishable. No id while the pool is
   * selected is a boot error. → `docs/spec/28-cross-fleet-pool.md#configuration`
   */
  fleetId?: string;
  /**
   * The cross-fleet pool's coordinates. Required when `integrations.pool` selects anything
   * but `fake`. No secret is ever here — the `git` transport authenticates as git already does.
   */
  pool?: PoolConfig;
  /**
   * GitHub target + optional scope filters, required when a capability uses the `github`
   * provider. The auth token is deliberately not here — it comes from `GITHUB_TOKEN`.
   */
  github?: GitHubConfig;
  /**
   * Azure DevOps target + optional scope filters, required when a capability uses the
   * `azure` provider. Auth is deliberately not here: a PAT comes from `AZURE_DEVOPS_PAT`,
   * falling back to the logged-in `az` CLI.
   */
  azureDevOps?: AzureDevOpsConfig;
  /**
   * The prefix behind the cockpit's watch toggle, deriving one label — `${labelPrefix}-watch`.
   * Everything is opt-in. An empty prefix turns the gate off entirely. Defaults to `"lubbdubb"`.
   */
  labelPrefix: string;
  /**
   * Label → priority weight for ordering issue pickup. Replaced wholesale by an override
   * (not merged).
   */
  issuePriorityLabels: Record<string, number>;
  /** Weight for an issue carrying no matching priority label. */
  issueDefaultPriority: number;
  /**
   * How much of the story-sequencing gate is on. Defaults to `off`.
   * - `off` — no order is read and nothing is held.
   * - `links` — honour the tracker's own dependency links.
   * - `full` — links plus the sequencer. Not built yet; reads as `links` until it is.
   * Never withholds work on a tracker that reports no dependencies at all. → `docs/spec/33-story-sequencing.md`
   */
  issueSequencing: IssueSequencing;
  /**
   * Above this many watched, open stories a Feature is not sequenced at all. Fails open —
   * the Feature keeps the ordering it has, which is none.
   */
  issueSequenceMaxChildren: number;
  /**
   * Tracker state → `#rrggbb`, for the state chip the cockpit draws. Display only. Keys
   * match on letters and digits only. Replaced wholesale by an override, not merged.
   */
  issueStateColours: Record<string, string>;
  /**
   * The tracker's own state words, in the order the Tickets board draws them as columns.
   * Empty (default) = every state the mirror carries, in the facets' own count order. An
   * order rather than a set: no provider reports column order. Display only.
   */
  issueBoardStates: string[];
  /**
   * Dispatcher-level, state-based pickup gate. When non-empty, only issues whose
   * provider-native workflow state is in this list are picked up. Meaningful only for
   * providers with a richer state model (Azure). Unset/empty = act on all open issues.
   */
  issuePickupStates?: string[];
  /**
   * The state a work item is moved to once a PR is open for it, so agents stop re-picking
   * work already done. Takes effect only alongside `issuePickupStates` and needs a
   * provider that can write state back. Unset = no automatic transition.
   */
  issueInReviewState?: string;
  /**
   * The state a work item is moved to once an agent is actually working it. Folded into
   * the effective pickup states, so should not also be listed in `issuePickupStates` —
   * doing so lifts an assessed item's own delivery hold.
   */
  issueInProgressState?: string;
  /**
   * Provider-native item types that hold work rather than being work — never picked up,
   * planned or appraised. Meaningful only for providers reporting an item type (Azure).
   * Defaults to `["Feature", "Epic"]`; `[]` turns the gate off. Case-insensitive.
   */
  issueContainerTypes: string[];
  /**
   * Provider-native item types expected to hang off a container. One of these with no
   * parent is an orphan the appraisal prompt reports. List your own process template's
   * names if it uses others — an unnamed type never gets its missing parent reported.
   * `[]` turns the report off. Azure DevOps only.
   */
  issueParentedTypes: string[];
  /**
   * The work item types the harness files at. The first entry is what it creates (a bug
   * goes to `issueBugType` instead). Sent to Azure verbatim, so must match the project's
   * names exactly. `[]` falls back to the default — a work item is always created *as* something.
   */
  issueFilingTypes: string[];
  /**
   * The work item type a bug an operator raised is filed as. Defaults to `"Bug"`. Its own
   * key rather than matched out of `issueFilingTypes`, to avoid mis-filing a story as a bug.
   */
  issueBugType?: string;
  /**
   * The planning funnel for multi-PR issues. Every watched open issue gets a planning
   * agent, and its verdict is put to you before any agent is spent. Deep-merged.
   */
  planning: PlanningPolicy;
  /**
   * The feature board — the cockpit tab reading fleet work per Feature. Off by default;
   * the flag is only half the gate — the connector must also be able to place a work item.
   * Also spends one desk agent per Feature whose work has moved (rule `feature-summary`).
   * → `docs/spec/17-cockpit.md#the-feature-board`
   */
  featureBoard: boolean;
  /**
   * The live burn watch — flags a run spending far past what its kind of work costs. On
   * by default: spends no agent, gates nothing, just files/settles a `burn` obligation.
   * Deep-merged.
   */
  spendBurn: BurnPolicy;
  /**
   * The runway watch — how thin the work queue may get before somebody is told. On by
   * default, spends no agent, gates nothing. Deep-merged.
   */
  runway: RunwayPolicy;
  /**
   * The vivarium — creatures that hatch from what the operator does. On by default and
   * inert: no agent, no gate. Off stops the scan; `visible: false` only hides it. Rates
   * are constants in `src/pets/rules.ts`. → `docs/spec/22-pets.md#authenticity`
   */
  pets: PetPolicy;
  /**
   * The self-update watch — checks the harness's own build against upstream. Runs against
   * the directory LubbDubb is installed in, never `repoRoot`. On by default and cheap.
   * `autoUpdate` (off by default) is whether the harness applies what it finds.
   */
  selfUpdate: SelfUpdatePolicy;
  /**
   * The validation plan — how anyone checks the goal was met, as runnable steps. On by
   * default: spends no agent, gates nothing; only consequence is a goal closed with checks
   * outstanding says so. Deep-merged.
   */
  validation: ValidationPolicy;
  /**
   * The fleet review — whether the harness reviews its own PRs before a person does. Off
   * by default, unlike the other blocks: it is the one rule that spends an agent on every
   * PR. Deep-merged. → `docs/spec/07-pull-requests.md#the-fleet-review`
   */
  review: PrReviewPolicy;
  /**
   * The local run — the one dev environment on the operator's machine. Deep-merged. Empty
   * `instruction` means nothing is startable, the whole of the off switch.
   */
  localRun: LocalRunPolicy;
  /**
   * The local validation — the fleet driving that same environment to say whether a
   * goal's changes work. Own block rather than fields on `localRun`: that starts the
   * environment, this uses it.
   */
  localValidation: LocalValidationPolicy;
  /**
   * How far back a provider looks for PRs that have left the open set, so a merge or
   * abandonment is observed rather than inferred from disappearance. Costs one extra list
   * request per snapshot per provider. `0` disables the lookup (supported).
   */
  closedPrWindowMs: number;
  /**
   * How long an obstacle nobody re-reports and nothing owns stays on the board before
   * going `dormant`. Keys survive it, so a matching report reopens the row rather than
   * filing a second one. → `docs/spec/27-obstacles.md#how-an-obstacle-ends`
   */
  obstacleDormantMs: number;
  /**
   * The environments a goal's landed work travels to after merge, and how to ask each
   * whether it has a given commit. Empty by default, which turns the whole feature off.
   * → `docs/spec/24-environments.md#configuring-an-environment`
   */
  environments: EnvironmentConfig[];
  /** How often a landing not yet confirmed in an environment is asked about again. A confirmed landing is never re-asked. */
  environmentProbeIntervalMs: number;
  /**
   * How often an environment's `health` command is asked. Own interval rather than
   * {@link environmentProbeIntervalMs}: asked regardless of whether anything shipped.
   */
  environmentHealthIntervalMs: number;
  /**
   * How often an open post-deploy watch asks its environment again. Not
   * {@link environmentProbeIntervalMs} — a 24h percentile does not move in five minutes.
   * → `docs/spec/29-post-deploy-watch.md#cost`
   */
  watchIntervalMs: number;
  /**
   * Per-check CI policy: what the harness does about which check went red. Rules are
   * ordered, matched by glob against the check name, first match wins. A check matching
   * no rule gets a code agent with the generic fix prompt.
   */
  ci: CiPolicy;
  /**
   * How long an operator "Up next" priority override survives after the harness stops
   * tracking its origin. `last_seen_at` refreshes while the origin is live or staffed.
   * Defaults to 7 days; `0` disables pruning.
   */
  upNextOverrideTtlMs: number;
  /**
   * How agents are launched.
   * - `stream`: real Claude Code over headless stream-JSON. Production default, only mode that runs a model.
   * - `raw`: the mock agent — runs `claudeCommand`/`claudeArgs` verbatim, speaks no protocol.
   * → [10](../../docs/spec/10-agent-runtimes.md)
   */
  agentMode: 'stream' | 'raw';
  /** Passed to `claude --permission-mode` so unattended tool calls don't hang the agent. */
  agentPermissionMode: string;
  /**
   * Which model each kind of work runs on, keyed on the dispatch rule that proposed it —
   * see {@link AgentModels}. Config file only. The resolved model is stored on the task at
   * dispatch, so a resumed agent re-launches on what it started on. Merges whole, not field by field.
   */
  agentModels?: AgentModels;
  /**
   * Tool allow rules handed to every agent as a `permissions.allow` fragment in
   * `--settings`, pre-approving mechanical validate/commit/push commands. Not put on
   * `--allowedTools` — that carries MCP tool grants, and mixing a Bash rule in drops them.
   */
  agentAllowedTools: string[];
  /** Wait this long after spawn before typing the task in, giving the REPL time to boot. */
  agentPromptDelayMs: number;
  /**
   * Gap between writing a message and the submitting carriage return. `raw` only — a line
   * editor folds one burst into a paste otherwise, leaving the text unsubmitted.
   */
  agentSubmitDelayMs: number;
  /** Extra literal substrings meaning "the CLI is waiting for input" — backup escalation heuristic for `raw`. */
  agentWaitingPatterns: string[];
  /**
   * How many times an agent that ends a turn with no sentinel is asked to account for
   * itself before the stop is put to a human. Whole-life budget per agent, not per stop.
   * 0 restores the immediate park. Stream runtime only.
   */
  agentStallNudges: number;
  /**
   * How long an unannounced stop stands parked before the harness settles it as `done`
   * itself. 0 leaves it standing forever. Settling releases the worktree slot and
   * dispatches again if there is more to do.
   */
  agentStallParkMs: number;
  /** How much one press of Extend adds to a stall park's countdown, additive from now. */
  agentStallExtendMs: number;
  /**
   * How long a stream agent may produce no output before the harness parks it and starts
   * the same countdown an unannounced stop gets. 0 disables it. Restarted by every byte on stdout.
   */
  agentSilenceParkMs: number;
  /**
   * How many times a live agent whose process dies mid-run is re-attached to its own
   * session before the harness settles it as failed (issue #318). Counted on
   * `agents.resume_attempts`, so it survives a restart. 0 disables automatic resume.
   */
  agentResumeAttempts: number;
  /**
   * How long a recorded MCP call keeps its arguments, in days. `0` records none at all —
   * the row itself is never dropped, only the arguments. → `docs/spec/14-persistence.md#mcp-calls`
   */
  mcpArgsRetentionDays: number;
  /** Command used to launch an agent session (overridable for tests). */
  claudeCommand: string;
  /** Extra args passed to the agent command. */
  claudeArgs: string[];
  /**
   * Folder(s) the file-events hook treats as the artifacts area: any file an agent writes
   * under a prefix is promoted to an artifact chip regardless of extension. A relative
   * entry is worktree-relative; an absolute one widens the artifact-serving boundary.
   */
  docsFolderPrefix?: string | string[];
  /**
   * Directory of operator overrides for the rule dispatcher's agent/escalation prompts.
   * Each `<prompt-id>.md` replaces that prompt's built-in default; ids without a file keep
   * the default. Defaults to `.lubbdubb/prompts`.
   */
  promptTemplatesDir: string;
  /** Root under which the pool of worktree slot directories lives. */
  worktreeRoot: string;
  /** Root under which desk (no-code) scratch dirs are created. */
  deskRoot: string;
  /**
   * Root under which images attached to a brief are stored. Deliberately outside every
   * worktree, so a screenshot can never be committed onto a branch. Every launched agent
   * is granted read access to this whole root — a real widening.
   */
  attachmentRoot: string;
  /** Root under which a goal's validation resources are kept, one directory per goal. Same storage rule as `attachmentRoot`. */
  validationRoot: string;
  /**
   * The one checkout the local run's application is started in — a real worktree, kept
   * warm and deliberately outside `worktreeRoot` (the pool's `slots()` counts every
   * registered worktree under its root and would wipe this one). → [09](docs/spec/09-execution.md#the-checkout-a-local-run-uses)
   */
  localRunRoot: string;
  /** The git repo the harness operates on (worktrees are cut from here). */
  repoRoot: string;
  /**
   * The repository's integration branch — what a new agent branch is cut from and what a
   * PR targets. Defaults to `"main"`. Not auto-detected: a wrong guess silently mis-bases work.
   */
  defaultBranch: string;
  /** SQLite file. */
  dbPath: string;
  /** HTTP/WS port. */
  port: number;
  /**
   * Address the HTTP/WS server binds to. Defaults to `127.0.0.1` — the cockpit can spawn
   * agents with repo write access, so reachability is deliberate. `"0.0.0.0"` is refused with `auth.enabled: false`.
   */
  host: string;
  /** Cockpit access control. See `src/server/auth.ts`. */
  auth: AuthConfig;
  /** Inbound webhook / service-hook ingress. See `src/ingress/ingress.ts`. */
  ingress: IngressBounds;
}

/**
 * Bearer-token access control for the cockpit surface. Deliberately no `token` field —
 * `Config` holds no secrets. The token comes from `LUBBDUBB_TOKEN` or is minted into
 * {@link AuthConfig.tokenFile} at 0600.
 */
interface AuthConfig {
  /** Master switch, on by default — this one only refuses callers, so an off-by-default guard is one nobody turns on. */
  enabled: boolean;
  /** Where a minted token is persisted. Relative paths resolve against the launch directory. */
  tokenFile: string;
}

/**
 * The bounds on the inbound ingress endpoint, and only the bounds. No `secret`/`enabled`
 * field: the secrets come from `LUBBDUBB_INGRESS_SECRET`/`LUBBDUBB_INGRESS_BASIC`, and
 * their presence is the on switch. Neither set answers `404`. → `docs/spec/30-ingress.md#turning-it-on`
 */
interface IngressBounds {
  /** How long a burst of deliveries settles before one cycle fires. */
  debounceMs: number;
  /** The floor between two cycles a delivery may cause — bounds what an inbound flood can cost this fleet's provider budget. */
  minCycleGapMs: number;
  /** Deliveries accepted per minute across the whole endpoint, before a `429`. */
  requestsPerMinute: number;
  /** Largest delivery body read, before a `413`. Bounds the work an unverified caller buys. */
  maxBodyBytes: number;
}

export interface GitHubConfig {
  /** Repository owner (user or org). */
  owner: string;
  /** Repository name. */
  repo: string;
}

export interface AzureDevOpsConfig {
  /** Organization (the `dev.azure.com/{organization}` segment). */
  organization: string;
  /** Project name — work items are scoped to it. */
  project: string;
  /** Git repository name within the project. */
  repository: string;
  /** Optional filters narrowing pickup. Identity-based narrowing is not here — see {@link Config.userId} and {@link Config.ownWorkOnly}. */
  filters?: {
    /** Only surface work items carrying this tag. Unset = all open work items. */
    workItemTag?: string;
  };
  /**
   * Which branch-policy kinds become CI checks, and how. `check` is ordinary; `advisory`
   * is visible but cannot dispatch or escalate; `off` drops it. Unset kinds default to
   * `check` for build/status, `advisory` for comments, `off` for the rest. `ciStatus`
   * folds enabled, blocking build/status policies only, so widening this can never make a PR read as unable to merge.
   */
  policyChecks?: PolicyCheckModes;
}

/**
 * The pool's coordinates. Every field but {@link PoolConfig.digestIntervalMs} belongs in
 * the project layer, since each is a fact about the project rather than this machine.
 * → `docs/spec/28-cross-fleet-pool.md#configuration`
 */
interface PoolConfig {
  /**
   * What this project is called in the pool, declared in `lubbdubb.project.json` and
   * committed, so every clone reads the same string. No derivation fallback — a pool
   * switched on against a project with no name is a boot error.
   */
  project?: string;
  /** The `git` transport's remote. Any repository git can reach; it need not be the pool's own. */
  remote?: string;
  /** The branch the pool lives on. */
  branch?: string;
  /**
   * A prefix inside that repository, so an existing wiki hosts the pool in a folder
   * rather than at its root. Empty by default. A path escaping the clone is refused at
   * config load. The prefix is the transport's, never the payload's — no document records it.
   */
  path?: string;
  /** How often the digest is republished and the backstop re-derives both documents. One hour by default; no separate poll interval — the pulse is the clock. */
  digestIntervalMs?: number;
}

export interface WhitelistRule {
  /** Substring matched against the agent's waiting prompt. */
  match: string;
  /** The text automatically typed back into the session. */
  response: string;
}

const DEFAULTS: Config = {
  // Thirty seconds busy, five minutes idle. The arithmetic behind both is in
  // `docs/spec/15-integrations.md#what-the-cadence-costs`.
  heartbeatIntervalMs: 30 * 1000,
  idleHeartbeatIntervalMs: 5 * 60 * 1000,
  hotReadMaxAgeMs: DEFAULT_READ_LANES.hotMaxAgeMs,
  coldReadMaxAgeMs: DEFAULT_READ_LANES.coldMaxAgeMs,
  maxConcurrentAgents: 3,
  startPaused: false,
  // On: replies go out, and `false` is how an operator asks to be asked. The one default
  // here that changes what an existing deployment does. See the key's doc.
  sendPrRepliesWithoutApproval: true,
  whitelistedApprovals: [],
  // True, so splitting off `userId` changes nothing for an existing deployment: one
  // carrying an identity keeps its gates, one without keeps them off.
  ownWorkOnly: true,
  // `fake` everywhere, so a fresh clone never touches the network and stays testable.
  integrations: { sourceControl: 'fake', issues: 'fake', pool: 'fake' },
  // Empty rather than absent, so a project layer setting one field merges rather than
  // replaces — `DEEP_MERGED_BLOCKS`' rule.
  pool: {},
  labelPrefix: 'lubbdubb',
  issuePriorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  issueDefaultPriority: 2,
  // Off: the gate is the one mechanism here that can withhold work, so a default that
  // held anything would park a Feature nobody asked it to.
  issueSequencing: 'off',
  issueSequenceMaxChildren: DEFAULT_SEQUENCE_MAX_CHILDREN,
  issueStateColours: {},
  // Empty on purpose: with no order stated the board falls back to the state facets.
  issueBoardStates: [],
  issueContainerTypes: [...DEFAULT_CONTAINER_TYPES],
  issueParentedTypes: [...DEFAULT_PARENTED_TYPES],
  issueFilingTypes: [...DEFAULT_FILING_TYPES],
  // Each policy's own module owns the operator default; the dispatcher's fallback for an
  // omitted policy is a separate answer (off) and lives with the rules.
  planning: DEFAULT_PLANNING,
  featureBoard: false,
  spendBurn: DEFAULT_BURN,
  runway: DEFAULT_RUNWAY,
  // One switch and no rates: everything a pet costs is a constant in `src/pets/rules.ts`.
  pets: { enabled: true, visible: true },
  selfUpdate: {
    enabled: true,
    remote: 'origin',
    branch: 'main',
    // Fifteen minutes rather than an hour: the upgrade ask is raised from this reading.
    checkIntervalMs: 15 * 60 * 1000,
    // Off by default: taking a build out from under a fleet is a decision.
    autoUpdate: false,
    drainDeadlineMs: 2 * 60 * 60 * 1000,
    // On by default, unlike `autoUpdate`: interrupts and restarts nothing.
    projectAutoPull: true,
    snoozeMs: 30 * 60 * 1000,
  },
  validation: DEFAULT_VALIDATION,
  review: DEFAULT_PR_REVIEW,
  localRun: DEFAULT_LOCAL_RUN,
  localValidation: DEFAULT_LOCAL_VALIDATION,
  closedPrWindowMs: 6 * 60 * 60 * 1000,
  obstacleDormantMs: 7 * 24 * 60 * 60 * 1000,
  // Empty is the off switch, not an empty list of something switched on.
  environments: [],
  environmentProbeIntervalMs: 5 * 60 * 1000,
  environmentHealthIntervalMs: 5 * 60 * 1000,
  watchIntervalMs: 30 * 60 * 1000,
  ci: { checks: [] },
  upNextOverrideTtlMs: 7 * 24 * 60 * 60 * 1000,
  agentMode: 'stream',
  agentPermissionMode: 'acceptEdits',
  // The mechanical validate/commit/push commands a coding agent needs to take an issue to
  // an opened PR unattended. Everything else prompts and routes to the operator.
  agentAllowedTools: [
    'Bash(npm:*)',
    'Bash(npx:*)',
    'Bash(pnpm:*)',
    'Bash(yarn:*)',
    'Bash(node:*)',
    'Bash(git:*)',
    'Bash(gh:*)',
  ],
  agentPromptDelayMs: 1200,
  agentSubmitDelayMs: 60,
  agentWaitingPatterns: [],
  agentStallNudges: 2,
  agentStallParkMs: 300_000,
  agentStallExtendMs: 900_000,
  agentSilenceParkMs: 1_800_000,
  agentResumeAttempts: 3,
  // A fortnight: still answers "how is this tool being used" for last sprint, without
  // holding a year of agent arguments nobody reads.
  mcpArgsRetentionDays: DEFAULT_MCP_ARGS_RETENTION_DAYS,
  claudeCommand: 'claude',
  claudeArgs: [],
  promptTemplatesDir: '.lubbdubb/prompts',
  worktreeRoot: '.lubbdubb/worktrees',
  deskRoot: '.lubbdubb/desk',
  attachmentRoot: '.lubbdubb/attachments',
  validationRoot: '.lubbdubb/validation',
  localRunRoot: '.lubbdubb/local-run',
  repoRoot: process.cwd(),
  defaultBranch: 'main',
  dbPath: '.lubbdubb/lubbdubb.sqlite',
  port: 4300,
  host: '127.0.0.1',
  auth: { enabled: true, tokenFile: '.lubbdubb/cockpit-token' },
  // A second of debounce (a burst here is one push firing four checks), and a
  // five-second floor capping an inbound flood at twelve real cycles a minute.
  ingress: { debounceMs: 1_000, minCycleGapMs: 5_000, requestsPerMinute: 600, maxBodyBytes: 1_048_576 },
};

/**
 * Resolve the five path fields against the roots they belong to, in place. Lifted out of
 * {@link loadConfig} so {@link defaultConfig} builds a baseline by the same rules.
 */
function resolveRootPaths(merged: Config): void {
  // A relative override is resolved to absolute: git runs with `cwd: repoRoot` and
  // agents in a worktree cwd, so a relative path would resolve against the wrong directory.
  merged.repoRoot = resolve(process.cwd(), merged.repoRoot);

  // Agents' working roots resolve against `repoRoot`, not `process.cwd()` — otherwise
  // running LubbDubb from its own folder scatters another repo's worktrees into it.
  merged.worktreeRoot = resolve(merged.repoRoot, merged.worktreeRoot);
  merged.deskRoot = resolve(merged.repoRoot, merged.deskRoot);
  merged.attachmentRoot = resolve(merged.repoRoot, merged.attachmentRoot);
  merged.validationRoot = resolve(merged.repoRoot, merged.validationRoot);
  // Must land outside `worktreeRoot`, or the pool counts it as one of its own slots.
  merged.localRunRoot = resolve(merged.repoRoot, merged.localRunRoot);

  merged.promptTemplatesDir = resolve(merged.repoRoot, merged.promptTemplatesDir);
}

/**
 * Defaults plus one layer, deep-merged and path-resolved — everything {@link loadConfig}
 * does, short of the refusals, which stay there because a project layer read alone can
 * fail a check the operator's layer above it settles.
 */
function mergeConfig(overrides: Partial<Config> = {}): Config {
  const merged = { ...DEFAULTS, ...overrides };
  resolveRootPaths(merged);
  merged.integrations = { ...DEFAULTS.integrations, ...overrides.integrations };
  merged.pool = { ...DEFAULTS.pool, ...overrides.pool };
  merged.planning = { ...DEFAULTS.planning, ...overrides.planning };
  merged.pets = { ...DEFAULTS.pets, ...overrides.pets };
  merged.spendBurn = { ...DEFAULTS.spendBurn, ...overrides.spendBurn };
  merged.runway = { ...DEFAULTS.runway, ...overrides.runway };
  merged.selfUpdate = { ...DEFAULTS.selfUpdate, ...overrides.selfUpdate };
  merged.validation = { ...DEFAULTS.validation, ...overrides.validation };
  merged.review = { ...DEFAULTS.review, ...overrides.review };
  merged.localRun = { ...DEFAULTS.localRun, ...overrides.localRun };
  merged.localValidation = { ...DEFAULTS.localValidation, ...overrides.localValidation };
  merged.auth = { ...DEFAULTS.auth, ...overrides.auth };
  merged.ingress = { ...DEFAULTS.ingress, ...overrides.ingress };
  // An ordered list, so a replace and not a merge: a caller that sets `ci` means the list it wrote.
  merged.ci = { checks: overrides.ci?.checks ?? DEFAULTS.ci.checks };
  // A list, so it replaces rather than merges. Naming the key with nothing under it means "no environments".
  merged.environments = overrides.environments ?? DEFAULTS.environments;
  return merged;
}

/**
 * The baseline an operator's own file is read against: built-in defaults with the
 * project layer folded in, so a team-set value reads as inherited rather than theirs.
 */
export function baselineConfig(project: Partial<Config> = {}): Config {
  return mergeConfig(project);
}

/**
 * The config a deployment that configures nothing runs on, put through the same path
 * resolution {@link loadConfig} applies. Not `DEFAULTS` itself: the raw literals would
 * make path fields read as operator-chosen everywhere.
 */
export function defaultConfig(): Config {
  return mergeConfig();
}

/**
 * Keys that used to mean something and no longer do, each with the reason. A removed key
 * would merge into nothing and take the default while the file goes on saying otherwise,
 * so these refuse at load instead, naming the key. The entries are permanent.
 */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
  dispatcher:
    'the "claude" dispatcher was removed and the rule dispatcher is the only one, so there is nothing left to select',
  steeringPriorities: 'it was only ever injected into the removed "claude" dispatcher\'s prompt and now steers nothing',
  // Deliberately not revived as the boolean that replaced it: an old `autoSend` was a
  // block, so sharing the name would merge an object where a boolean is expected.
  autoSend:
    'it gated on a confidence threshold that resolved between two constants and measured nothing — if you want the harness to send a drafted reply without asking, set "sendPrRepliesWithoutApproval": true, which is replies only and has no threshold; a merge is still authorized per pull request by landing a stack',
};

/**
 * Keys that used to be switches and no longer are, each with the reason. These warn and
 * are dropped, where {@link REMOVED_KEYS} refuses: everything here named a subsystem that
 * is now unconditional. A key is either a top-level name or one `block.key` path. Permanent.
 */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  'planning.enabled': 'the planning funnel is always on — every goal is planned',
  'planning.requireApproval':
    'a plan is always put to you before anything is scheduled from it — the undo for a plan that started itself is a replan, which is strictly worse than not starting',
  worktreePoolSize:
    'the worktree pool is the live agent cap plus slack, so "maxConcurrentAgents" is the fleet\'s one size knob — a second bound could only sit above the cap (disk nothing can lease) or below it (the fleet\'s real limit, with nothing saying so)',
  'validation.enabled': 'validation plans are always on',
  'validation.desktop':
    'the desktop channel is always on — the cockpit offers a desktop prompt on every unrun check, so a harness that was not listening was a dead end with nothing to say so',
  'validation.desktopSkill': 'the /lubbdubb skill is always installed and refreshed when the desktop channel starts',
  assessment: 'the assessor is always on — a goal with work behind it and nothing in flight is always assessed',
  'assessment.enabled': 'the assessor is always on',
  appraisal: 'the goal appraisal is always on — every fresh goal is appraised before anything is dispatched against it',
  'appraisal.enabled': 'the goal appraisal is always on',
  retrospective: 'the retrospective is always on — every delivered goal is written up',
  'retrospective.enabled': 'the retrospective is always on',
  mcp: 'the agent tool channel and its permission backstop are always on',
  'mcp.enabled': 'the agent tool channel is always on',
  'mcp.permissionEscalation': 'the permission backstop is always on',
  reapMergedBranches: 'the branch behind a merged pull request of yours is always reaped',
  reviewReminderMs: 'the cockpit ages every pull request waiting on a reviewer, with no threshold to cross',
  issuePickupRequireOwnLabel: 'the ownership gate is "ownWorkOnly", and who "own" means is "userId"',
  'github.defaultAssignee': 'tickets the harness files are assigned to "userId"',
  'azureDevOps.defaultAssignee': 'tickets the harness files are assigned to "userId"',
  lessonBlockChars:
    'nothing is injected fleet-wide any more — the claim store this bounded is gone, and everything the obstacle board holds is keyed and delivered to the dispatches it is about',
  knowledgeBlockChars:
    'nothing is injected fleet-wide any more — the claim store this bounded is gone, and everything the obstacle board holds is keyed and delivered to the dispatches it is about',
  knowledgeScopeStaleDays: 'the Knowledge page it was a reading for is gone with the claim store behind it',
  knowledgeColdDays: 'the Knowledge page it was a reading for is gone with the claim store behind it',
  agentIdleWaitMs:
    'it was the removed "pty" runtime\'s silence watch, read off a terminal that had gone quiet — what replaced it is "agentSilenceParkMs", which reads the same silence off the stream protocol and parks on it, so a deployment that had tuned this figure boots on that key\'s default until somebody sets it',
  sessionTranscriptRoot:
    'only the removed "pty" runtime read it, to tail the transcript file `claude` writes per project — the stream transport carries the transcript in structure, so there is no file to find and no path to point at',
  'github.filters': 'pull requests are filtered to "userId"\'s while "ownWorkOnly" is on',
  'azureDevOps.filters.prAuthor': 'pull requests are filtered to "userId"\'s while "ownWorkOnly" is on',
  'azureDevOps.filters.workItemAssignedTo': 'work items are filtered to "userId"\'s while "ownWorkOnly" is on',
};

function dropRetiredKeys(fromFile: Partial<Config>, filePath: string): void {
  for (const [path, why] of Object.entries(RETIRED_KEYS)) {
    // Walk to the object owning the final segment, so `block.key` drops the field and a bare name drops the whole block.
    const segments = path.split('.');
    const key = segments.pop() as string;
    let owner: unknown = fromFile;
    for (const segment of segments) {
      if (typeof owner !== 'object' || owner === null) break;
      owner = (owner as Record<string, unknown>)[segment];
    }
    if (typeof owner !== 'object' || owner === null || !Object.hasOwn(owner, key)) continue;
    delete (owner as Record<string, unknown>)[key];
    console.warn(
      `[lubbdubb] ${filePath} sets "${path}", which no longer exists — ${why}. Ignoring it; delete the key.`,
    );
  }
}

function refuseRemovedKeys(fromFile: object, filePath: string): void {
  for (const [key, why] of Object.entries(REMOVED_KEYS)) {
    if (!Object.hasOwn(fromFile, key)) continue;
    throw new Error(`Refusing to start: ${filePath} sets "${key}", which no longer exists — ${why}. Delete the key.`);
  }
}

/**
 * The pool's coordinates, judged once with every layer folded in. Nothing is checked
 * while the pool is `fake`. The path check catches an absolute, rooted or `..`-bearing
 * `pool.path` that would resolve outside the clone.
 * → `docs/spec/28-cross-fleet-pool.md#living-in-somebody-elses-repository`
 *
 * `fleetId` is deliberately not checked here — it is the operator's key, so a missing one
 * is a `fleet` row on Needs you and the pool desk sits out until answered.
 * → `docs/spec/28-cross-fleet-pool.md#a-fleet-with-no-name-yet`, `docs/spec/26-setup.md`
 */
function validatePool(merged: Config): void {
  const path = merged.pool?.path ?? '';
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error(
      `Refusing to start: pool.path ("${path}") escapes the pool's clone. It is a prefix *inside* the ` +
        `repository the pool is given — "engineering/fleet-pool", or empty for the repository root. ` +
        `An absolute, rooted or ".."-bearing path would have the harness writing outside the clone.`,
    );
  }
  if (merged.integrations.pool === 'fake') return;
  if (!merged.pool?.project) {
    throw new Error(
      `Refusing to start: integrations.pool is "${merged.integrations.pool}" but no pool.project is set. ` +
        `The project name is what decides whose claims are relevant to whom, and it is declared in the ` +
        `committed lubbdubb.project.json so every clone reads the same string. There is no derivation fallback.`,
    );
  }
  if (merged.integrations.pool === 'git' && (!merged.pool.remote || !merged.pool.branch)) {
    throw new Error(
      `Refusing to start: the git pool transport needs coordinates — set "pool.remote" and "pool.branch" ` +
        `in lubbdubb.project.json. No credential goes there: git authenticates the way it already does for that host.`,
    );
  }
}

/**
 * The review's one refusal: a `defaultMode` naming a mode that does not exist. Refused at
 * load because `defaultMode` is the fail-open target — a typo there looks correct until
 * something else goes wrong. An empty `modes` and a single mode are both legal.
 * → `docs/spec/07-pull-requests.md#choosing-how-to-review`
 */
function validateReview(merged: Config): void {
  const named = merged.review.defaultMode;
  if (named === null) return;
  const modes = Object.keys(merged.review.modes);
  if (!modes.includes(named)) {
    throw new Error(
      `Refusing to start: review.defaultMode is "${named}", which is not one of review.modes ` +
        `(${modes.join(', ') || 'none declared'}). It names the mode a review falls back to when the triage ` +
        `cannot answer, so a name with nothing behind it is only reached on the day something else went wrong.`,
    );
  }
}

/**
 * The one value that no longer means anything, refused by name. `agentMode` still
 * chooses between the two runtimes left; `src/system.ts` indexes a two-key table by this
 * string and would die naming nothing. → `docs/spec/10-agent-runtimes.md`
 */
function validateAgentMode(merged: Config): void {
  const mode: string = merged.agentMode;
  if (mode === 'stream' || mode === 'raw') return;
  throw new Error(
    `Refusing to start: agentMode is "${mode}", and the only modes are "stream" (real Claude Code over ` +
      `headless stream-JSON, the only one that runs a model) and "raw" (the mock — your argv over a terminal). ` +
      `"pty" is gone: everything it alone could do, the stream transport now carries in structure. Set ` +
      `"agentMode": "stream".`,
  );
}

/**
 * The nested policy blocks, which merge field by field where everything else replaces.
 * The rule a block must satisfy to stay off this list is that nothing offers a per-leaf
 * edit over it — otherwise a replace silently loses every sibling a lower layer set.
 * `ci` is here despite keeping replace-when-present semantics: the one-deep merge only
 * stops an absent `checks` shadowing the list underneath.
 */
export const DEEP_MERGED_BLOCKS = [
  'integrations',
  'planning',
  'pets',
  'spendBurn',
  'runway',
  'selfUpdate',
  'validation',
  'review',
  'localRun',
  'localValidation',
  'auth',
  'ingress',
  'ci',
  'github',
  'azureDevOps',
  'pool',
] as const;

/**
 * The blocks inside {@link DEEP_MERGED_BLOCKS} that are themselves nested and carry a
 * per-leaf edit of their own. One extra level rather than general recursion.
 */
const DEEP_MERGED_SUBBLOCKS: Partial<Record<(typeof DEEP_MERGED_BLOCKS)[number], readonly string[]>> = {
  azureDevOps: ['filters'],
};

/**
 * Deep-merge one config layer over another, the way {@link loadConfig} merges a layer
 * over {@link DEFAULTS}. Only {@link deploymentLayers} needs it — a shallow fold of its
 * four layers would let an upper block drop fields a lower file set.
 */
function mergeLayers(lower: Partial<Config>, upper: Partial<Config>): Partial<Config> {
  const merged: Partial<Config> = { ...lower, ...upper };
  for (const key of DEEP_MERGED_BLOCKS) {
    if (lower[key] === undefined && upper[key] === undefined) continue;
    // What each layer *said*, and nothing else — defaults fold in once, at the bottom, in
    // `mergeConfig`. Folding them here too would shadow the project layer with a policy no file states.
    const block: Record<string, unknown> = { ...lower[key], ...upper[key] };
    for (const sub of DEEP_MERGED_SUBBLOCKS[key] ?? []) {
      const below = (lower[key] as Record<string, unknown> | undefined)?.[sub];
      const above = (upper[key] as Record<string, unknown> | undefined)?.[sub];
      if (below === undefined && above === undefined) continue;
      block[sub] = { ...(below as object), ...(above as object) };
    }
    (merged as Record<string, unknown>)[key] = block;
  }
  return merged;
}

/**
 * The config a deployment runs on: {@link loadConfig} plus the three ambient layers — the
 * project's `lubbdubb.project.json`, a `lubbdubb.config.json` in the launch directory, and
 * env overrides — folded in underneath the explicit ones. This, not `loadConfig`, is what
 * a process entry point calls.
 */
export function loadDeploymentConfig(overrides: Partial<Config> = {}): Config {
  const filePath = configFilePath();
  const fromFile = existsSync(filePath) ? readFileLayer(readFileSync(filePath, 'utf8'), filePath) : {};
  return loadConfig(deploymentLayers(fromFile, overrides));
}

/** Where a deployment's config file lives. One answer, so nothing looks elsewhere. */
export function configFilePath(): string {
  return resolve(process.cwd(), 'lubbdubb.config.json');
}

/**
 * Where the targeted project's shared config lives: the root of the repo the harness
 * works on, committed rather than in the gitignored `.lubbdubb/`. A different name from
 * `lubbdubb.config.json`, because the two collide the moment a harness targets its own checkout.
 */
export function projectConfigFilePath(repoRoot: string): string {
  return resolve(repoRoot, 'lubbdubb.project.json');
}

/**
 * The layer the targeted project contributes, or nothing. Gets the same reading as an
 * operator's own file, except `repoRoot` is refused here (legal elsewhere) — this file
 * was found because `repoRoot` already resolved, so a value here could only describe the
 * search that found it. Takes the path rather than the repo root.
 */
export function projectConfigLayer(filePath: string): Partial<Config> {
  if (!existsSync(filePath)) return {};
  const layer = readFileLayer(readFileSync(filePath, 'utf8'), filePath);
  if (Object.hasOwn(layer, 'repoRoot')) {
    throw new Error(
      `Refusing to start: ${filePath} sets "repoRoot", which is the one key a project config cannot set — ` +
        `this file was read because repoRoot had already resolved, so a value here could only describe the ` +
        `search that found it. Point the harness with lubbdubb.config.json or LUBBDUBB_REPO_ROOT instead, and delete the key.`,
    );
  }
  return layer;
}

/**
 * The four ambient layers a deployment folds, in one place. `repoRoot` is settled from
 * the operator's layers alone, before anything is read from the project, because the
 * project's file lives at `repoRoot` — a layer cannot be consulted about where to find
 * itself. Shared by {@link loadDeploymentConfig} and {@link loadConfigFromText}.
 */
function deploymentLayers(fromFile: Partial<Config>, overrides: Partial<Config>): Partial<Config> {
  const operator = mergeLayers(mergeLayers(fromFile, envLayer()), overrides);
  const repoRoot = resolve(process.cwd(), operator.repoRoot ?? DEFAULTS.repoRoot);
  return mergeLayers(projectConfigLayer(projectConfigFilePath(repoRoot)), operator);
}

/**
 * The env overrides, as a layer. Its own function because the config-write path builds
 * the config a candidate file would produce, and needs the same list a UI can offer against.
 */
function envLayer(): Partial<Config> {
  const fromEnv: Partial<Config> = {};
  if (process.env.PORT) fromEnv.port = Number(process.env.PORT);
  if (process.env.LUBBDUBB_HOST) fromEnv.host = process.env.LUBBDUBB_HOST;
  if (process.env.LUBBDUBB_DB) fromEnv.dbPath = process.env.LUBBDUBB_DB;
  if (process.env.LUBBDUBB_REPO_ROOT) fromEnv.repoRoot = process.env.LUBBDUBB_REPO_ROOT;
  return fromEnv;
}

/** Parse one file's text into a config layer, refusing removed keys and dropping retired ones. */
function readFileLayer(text: string, filePath: string): Partial<Config> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Failed to parse ${filePath}: the config file must hold a JSON object`);
  }
  refuseRemovedKeys(parsed, filePath);
  const fromFile = parsed as Partial<Config>;
  dropRetiredKeys(fromFile, filePath);
  return fromFile;
}

/**
 * The config a given file text would produce on this machine, from text rather than
 * disk. This is how a save is validated: build the config the candidate would produce and
 * let it throw, so the form cannot write a config the next boot would reject.
 */
export function loadConfigFromText(text: string, filePath = configFilePath()): Config {
  return loadConfig(deploymentLayers(readFileLayer(text, filePath), {}));
}

/**
 * Defaults, the caller's overrides, path resolution and validation — nothing ambient.
 * Reads no file and no env var. {@link loadDeploymentConfig} is the entry point that adds
 * the operator's file and environment on top.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const merged = mergeConfig(overrides);

  // The one mode that is gone. Refused by name rather than left to fail obscurely.
  validateAgentMode(merged);

  validateCiPolicy(merged.ci);

  // A typo'd policy kind would otherwise be silently ignored.
  if (merged.azureDevOps?.policyChecks) validatePolicyCheckModes(merged.azureDevOps.policyChecks);

  // Same argument for the model policy: an unresolved profile or rule id would run as if nothing were configured.
  validateAgentModels(merged.agentModels);

  // And the burn watch: a multiple at or below 1, or a minimum of no runs, files
  // constantly and teaches the operator to stop reading it.
  validateBurnPolicy(merged.spendBurn);

  // And the runway watch: a clear threshold at or below the warn threshold oscillates.
  validateRunwayPolicy(merged.runway);

  // A nameless entry, a duplicate name or an empty command turns the feature into a confident wrong answer.
  validateEnvironments(merged.environments);

  // Each is supported alone; together they publish an endpoint that spawns agents with
  // repo write to every peer on the network. Refused rather than warned about.
  if (merged.host !== '127.0.0.1' && merged.host !== 'localhost' && merged.host !== '::1' && !merged.auth.enabled) {
    throw new Error(
      `Refusing to start: host "${merged.host}" is reachable off this machine and auth.enabled is false. ` +
        `The cockpit can queue jobs, which spawn agents with write access to your repo. ` +
        `Either bind 127.0.0.1 (the default) or leave auth on.`,
    );
  }

  // The local run's checkout must stay outside the pool: `slots()` counts every
  // registered worktree under `worktreeRoot`, so a `localRunRoot` inside it would be
  // leased to the next dispatch and wiped, with uncommitted preview work lost.
  if (pathsOverlap(merged.worktreeRoot, merged.localRunRoot)) {
    throw new Error(
      `Refusing to start: localRunRoot (${merged.localRunRoot}) overlaps worktreeRoot (${merged.worktreeRoot}). ` +
        `The pool counts every registered worktree under its root whatever the directory is called, so the local ` +
        `run's checkout would be leased to an agent and wiped. Point localRunRoot somewhere outside the pool.`,
    );
  }

  validatePool(merged);
  validateReview(merged);

  // Agents run in a worktree cwd, so a relative script path in claudeArgs must be made absolute up front.
  merged.claudeArgs = merged.claudeArgs.map((arg) => {
    if (isAbsolute(arg)) return arg;
    const candidate = resolve(process.cwd(), arg);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not a file — leave the arg untouched */
    }
    return arg;
  });
  return merged;
}

/**
 * Do two already-resolved directories occupy the same tree — one inside the other, or the
 * same path twice? Both directions checked, since both are the same mistake.
 */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const inside = (root: string, path: string): boolean => {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  return inside(a, b) || inside(b, a);
}
