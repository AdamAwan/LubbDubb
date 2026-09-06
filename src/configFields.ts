import { defaultConfig, type Config } from './config.js';

/**
 * What every configurable leaf *is* — the one declaration the config form, the save
 * validator, the live-apply switch and the reset action all read from. **Liveness is
 * deliberately not here**: whether saving a key takes effect now is decided by
 * whether `configApply.ts` re-seats whoever holds it, which a table cannot claim.
 * → `docs/spec/02-configuration.md#liveness`
 */
/** `text` is `string` drawn as a textarea — its own member, because the form switches on this union. */
export type ConfigFieldType = 'number' | 'boolean' | 'string' | 'text' | 'enum' | 'stringList' | 'json' | 'colourMap';

/**
 * How far an operator has to reach to edit a field. `advanced` means "this can lock
 * you out of the cockpit or point the fleet at the wrong repository"; `fileOnly` is
 * for a field no form should offer at all.
 */
export type ConfigFieldAccess = 'plain' | 'advanced' | 'fileOnly';

interface ConfigField {
  /** Dotted path into the config object, e.g. `planning.maxConcurrentPartsPerIssue`. */
  path: string;
  type: ConfigFieldType;
  /** The members, for an `enum`. */
  options?: readonly string[];
  access: ConfigFieldAccess;
  /** One line, shown under the key. The reason it exists, not a restatement of its name. */
  why: string;
  /**
   * The environment variable that beats the file for this key. A field carrying one is
   * drawn as overridden and refused for edit while it is set — the file would be
   * written and nothing would change.
   */
  env?: string;
  /** A duration in milliseconds, so the cockpit can say "5m" beside the number. */
  ms?: boolean;
  /**
   * The key whose value makes this one required, and the one value of it that does not
   * — `fleetId` is required while `integrations.pool` is anything but `fake`. The form
   * must evaluate it against what is **staged**, not what is running, and draws the
   * key even while unset; otherwise the save's refusal lands on a form with no field
   * to fix it.
   */
  requiredWhen?: ConfigFieldRequirement;
  /**
   * The keys to join into a value to *offer* for an unset field. An offer and never a
   * derivation — nothing writes it on the operator's behalf.
   * → `docs/spec/28-cross-fleet-pool.md#configuration`
   */
  suggest?: ConfigFieldSuggestion;
}

/** The key another key's requirement hangs on, and the one value of it that lifts it. */
export interface ConfigFieldRequirement {
  path: string;
  unless: string;
}

/** The keys to join into a suggested value, and what to join them with. Unexported: `suggestedValue` is the one reader. */
interface ConfigFieldSuggestion {
  join: readonly string[];
  with: string;
}

/**
 * Every leaf, in no particular order — display order is `GROUPS` in
 * `server/runningConfig.ts`. A `json` field is edited whole because it has no fixed
 * shape to draw: an ordered rule list, or a map whose keys the operator invents.
 */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  // ---- Dispatch ----------------------------------------------------------
  {
    path: 'heartbeatIntervalMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'Gap between timer-driven cycles.',
  },
  {
    path: 'idleHeartbeatIntervalMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'Gap between cycles while nothing is moving — no live agent, no queued work, no build in flight. Never shorter than the heartbeat itself.',
  },
  {
    path: 'hotReadMaxAgeMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How long a per-entity reading is reused for something that is moving (a build in flight, an open dispatch, merge-readiness in flux) when nothing on the cheap list payload says it changed.',
  },
  {
    path: 'coldReadMaxAgeMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'The same, for everything else. A cold item is still listed and still in the world every pulse; it just is not re-hydrated more often than this. The main lever on what a fast pulse costs the provider.',
  },
  {
    path: 'maxConcurrentAgents',
    type: 'number',
    access: 'plain',
    why: 'Hard cap on concurrently-running agents. Seeds the live cap, which a restart reverts to.',
  },
  {
    path: 'startPaused',
    type: 'boolean',
    access: 'plain',
    why: 'Boot with dispatch paused. Live pause/resume is ephemeral and separate.',
  },
  {
    path: 'sendPrRepliesWithoutApproval',
    type: 'boolean',
    access: 'plain',
    why: 'Send a reply an agent drafted straight to the review thread, without asking you. On by default — it is prose the fleet wrote, on a thread you do not control, signed as the harness. Turn it off to be asked instead: every draft then waits in your inbox as a proposal. Replies only; a merge is still authorized per pull request by landing a stack.',
  },
  {
    path: 'closedPrWindowMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How far back a provider looks for pull requests that have left the open set.',
  },
  {
    path: 'obstacleDormantMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How long an obstacle nobody re-reports and nothing owns stays on the board before it goes dormant. Its keys survive, so a re-report reopens it rather than filing a second one.',
  },
  {
    path: 'environments',
    type: 'json',
    // `fileOnly` because each entry is a shell command the harness runs on a
    // schedule — written deliberately in a file, not filled in beside twenty rows.
    access: 'fileOnly',
    why: 'Where landed work travels, and the command that says whether a commit has got there.',
  },
  {
    path: 'environmentProbeIntervalMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How often an unconfirmed landing is asked about again — and the precision of every “arrived at”.',
  },
  {
    path: 'environmentHealthIntervalMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How often each environment’s own health check is asked whether it is well.',
  },
  {
    path: 'watchIntervalMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How often an open post-deploy watch asks its environment again. Nothing is asked when none is open.',
  },
  {
    path: 'upNextOverrideTtlMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How long an operator’s Up next override outranks the dispatcher’s own order.',
  },

  // ---- Agents ------------------------------------------------------------
  {
    path: 'agentMode',
    type: 'enum',
    options: ['stream', 'raw'],
    access: 'plain',
    why: 'How agents are launched. The runtime object is picked once, at boot.',
  },
  {
    path: 'agentPermissionMode',
    type: 'string',
    access: 'plain',
    why: 'Permission posture handed to each agent. `bypassPermissions` is refused under root.',
  },
  {
    path: 'agentModels',
    type: 'json',
    access: 'plain',
    why: 'Which model each rule and each pinned profile dispatches on.',
  },
  {
    path: 'agentAllowedTools',
    type: 'stringList',
    access: 'plain',
    why: 'Tools an agent may use without asking. Rides in --settings, not --allowedTools.',
  },
  {
    path: 'agentPromptDelayMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'Wait before the prompt is delivered.',
  },
  {
    path: 'agentSubmitDelayMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'Gap between a terminal message and the carriage return that submits it.',
  },
  {
    path: 'agentWaitingPatterns',
    type: 'stringList',
    access: 'plain',
    why: 'Extra output patterns that mean an agent is waiting on a person.',
  },
  {
    path: 'agentStallNudges',
    type: 'number',
    access: 'plain',
    why: 'Nudges a stalled agent gets before it is given up on.',
  },
  {
    path: 'agentStallParkMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How long a stalled agent waits on you before the harness marks it done.',
  },
  {
    path: 'agentStallExtendMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How much one press of Extend adds to that countdown.',
  },
  {
    path: 'agentSilenceParkMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How long an agent may produce nothing at all before it is read as wedged.',
  },
  {
    path: 'agentResumeAttempts',
    type: 'number',
    access: 'plain',
    why: 'How many times a mid-run crash is re-attached before the run is failed.',
  },
  {
    path: 'mcpArgsRetentionDays',
    type: 'number',
    access: 'plain',
    why: 'How long a recorded MCP call keeps its arguments, in days. The call itself is kept for ever — only the arguments go. 0 records none at all.',
  },
  {
    path: 'whitelistedApprovals',
    type: 'json',
    access: 'fileOnly',
    why: 'Prompt substrings the harness may answer on your behalf. Written deliberately, in the file.',
  },
  {
    path: 'claudeCommand',
    type: 'string',
    access: 'advanced',
    why: 'The agent binary to launch.',
  },
  {
    path: 'claudeArgs',
    type: 'stringList',
    access: 'advanced',
    why: 'Extra arguments, appended last — an --allowedTools here silently drops the harness’s MCP grants.',
  },

  // ---- Integrations ------------------------------------------------------
  {
    path: 'integrations.sourceControl',
    type: 'enum',
    options: ['fake', 'github', 'azure'],
    access: 'plain',
    why: 'Which provider fulfils pull requests and branches.',
  },
  {
    path: 'integrations.issues',
    type: 'enum',
    options: ['fake', 'github', 'azure'],
    access: 'plain',
    why: 'Which provider fulfils issues.',
  },
  {
    path: 'integrations.pool',
    type: 'enum',
    options: ['fake', 'git'],
    access: 'plain',
    why: 'Which substrate carries the cross-fleet pool. "fake" publishes nowhere and runs no desk.',
  },
  {
    path: 'userId',
    type: 'string',
    access: 'plain',
    why: 'Who this harness acts as. Tickets it files are assigned to you and its branches are named as yours.',
  },
  {
    path: 'fleetId',
    type: 'string',
    access: 'plain',
    requiredWhen: { path: 'integrations.pool', unless: 'fake' },
    suggest: { join: ['userId', 'pool.project'], with: '@' },
    why: 'Who this fleet is in the pool. Person and target repo, e.g. "alice@acme-api" — never derived.',
  },
  {
    path: 'pool.project',
    type: 'string',
    access: 'plain',
    why: 'What this project is called in the pool. Belongs in the committed lubbdubb.project.json.',
  },
  { path: 'pool.remote', type: 'string', access: 'plain', why: 'The git pool transport’s remote.' },
  { path: 'pool.branch', type: 'string', access: 'plain', why: 'The branch the pool lives on.' },
  {
    path: 'pool.path',
    type: 'string',
    access: 'plain',
    why: 'A prefix inside that repository, so a shared wiki hosts the pool in a folder. Empty is its root.',
  },
  {
    path: 'pool.digestIntervalMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How often the digest republishes, and how often the backstop re-derives both documents.',
  },
  {
    path: 'ownWorkOnly',
    type: 'boolean',
    access: 'plain',
    why: 'Filter the world to you: pickup needs a watch tag you added, and only pull requests you opened are surfaced.',
  },
  { path: 'github.owner', type: 'string', access: 'plain', why: 'Repository owner (user or org).' },
  { path: 'github.repo', type: 'string', access: 'plain', why: 'Repository name.' },
  {
    path: 'azureDevOps.organization',
    type: 'string',
    access: 'plain',
    why: 'The dev.azure.com/{organization} segment.',
  },
  { path: 'azureDevOps.project', type: 'string', access: 'plain', why: 'Project name — work items are scoped to it.' },
  {
    path: 'azureDevOps.repository',
    type: 'string',
    access: 'plain',
    why: 'Git repository name within the project.',
  },
  {
    path: 'azureDevOps.filters.workItemTag',
    type: 'string',
    access: 'plain',
    why: 'Only surface work items carrying this tag.',
  },
  {
    path: 'azureDevOps.policyChecks',
    type: 'json',
    access: 'plain',
    why: 'Which branch-policy kinds become CI checks, and how.',
  },
  {
    path: 'labelPrefix',
    type: 'string',
    access: 'plain',
    why: 'Derives the ${prefix}-watch tag behind the cockpit’s watch toggle. Empty turns the gate off.',
  },
  {
    path: 'issuePriorityLabels',
    type: 'json',
    access: 'plain',
    why: 'Label → weight, for ordering pickup when headroom is short.',
  },
  {
    path: 'issueSequencing',
    type: 'enum',
    options: ['off', 'links', 'full'],
    access: 'plain',
    why: 'Whether a story waits for the one it depends on. `links` honours the tracker’s own Predecessor links and infers nothing; `off` holds nothing.',
  },
  {
    path: 'issueSequenceMaxChildren',
    type: 'number',
    access: 'plain',
    why: 'Above this many stories a Feature is not sequenced — the prompt would not fit and the order would not be read.',
  },
  {
    path: 'issueStateColours',
    type: 'colourMap',
    access: 'plain',
    why: 'Tracker state → colour for its chip, so a state is one you read rather than one you spell out.',
  },
  {
    path: 'issueBoardStates',
    type: 'stringList',
    access: 'plain',
    why: 'Tracker states as board columns, left to right. Empty = every state the mirror carries.',
  },
  {
    path: 'issueDefaultPriority',
    type: 'number',
    access: 'plain',
    why: 'Weight for an issue carrying no matching priority label.',
  },
  {
    path: 'issuePickupStates',
    type: 'stringList',
    access: 'plain',
    why: 'Only pick up items in these provider-native states. Empty = no state gate.',
  },
  {
    path: 'issueInReviewState',
    type: 'string',
    access: 'plain',
    why: 'State an item moves to once a pull request is open for it.',
  },
  {
    path: 'issueInProgressState',
    type: 'string',
    access: 'plain',
    why: 'State an item moves to once an agent is working it. Do not also list it in the pickup states.',
  },
  {
    path: 'issueContainerTypes',
    type: 'stringList',
    access: 'plain',
    why: 'Item types that hold work rather than being work. Their children are the work.',
  },
  {
    path: 'issueParentedTypes',
    type: 'stringList',
    access: 'plain',
    why: 'Item types expected to hang off a container. One of these with no parent is reported as an orphan and you are asked where it belongs; anything else is never asked. List your process template’s names — a type missing here is one no missing-parent question is ever raised for.',
  },
  {
    path: 'issueBugType',
    type: 'string',
    access: 'plain',
    why: 'The work item type a raised bug is filed as. Passed to the provider verbatim.',
  },
  {
    path: 'issueFilingTypes',
    type: 'stringList',
    access: 'plain',
    why: 'The work item types the harness may file. Passed to the provider verbatim.',
  },

  // ---- Features ----------------------------------------------------------
  {
    path: 'featureBoard',
    type: 'boolean',
    access: 'plain',
    why: 'Draw the Feature board — the fleet’s work rolled up per Feature — and let rule `feature-summary` spend one desk agent per Feature whose work has moved, to say where it has got to. Needs a tracker with a container hierarchy; on a provider without one the tab stays absent and nothing is summarised.',
  },
  {
    path: 'planning.maxConcurrentPartsPerIssue',
    type: 'number',
    access: 'plain',
    why: 'How many parts of one plan may have agents at once.',
  },
  {
    path: 'planning.gitFetchIntervalMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'Minimum gap between the fetches plan reconciliation runs before reading branch reality.',
  },
  {
    path: 'validation.desktopClaimMinutes',
    type: 'number',
    access: 'plain',
    why: 'How long a claimed validation check is held before it is offered again.',
  },
  {
    path: 'review.enabled',
    type: 'boolean',
    access: 'plain',
    why: 'Have the fleet review a pull request of its own before a person is asked to.',
  },
  {
    path: 'review.blocking',
    type: 'boolean',
    access: 'plain',
    why: 'Hold an unreviewed pull request out of the merge gate. Off records the verdict and gates nothing.',
  },
  {
    path: 'review.publish',
    type: 'enum',
    options: ['none', 'comment'],
    access: 'plain',
    why: 'Whether the reviewer posts what it found on the pull request, or keeps it to the harness.',
  },
  {
    path: 'review.publishedThreadProperty',
    type: 'string',
    access: 'plain',
    why: 'The thread property your review tooling stamps its own threads with. Set it, and findings read as dealt with once every stamped thread is resolved — the way a deployment that publishes findings itself, rather than through the reviewer agent, gets its mark back to green. Azure DevOps only; GitHub carries no thread properties.',
  },
  {
    path: 'review.publishedThreadRole',
    type: 'string',
    access: 'plain',
    why: 'Which stamped threads count — the value required on “<property>.role”. Empty takes every stamped thread, which on a poster that also opens an unresolvable summary thread never reads as dealt with.',
  },
  {
    path: 'review.modes',
    type: 'json',
    access: 'plain',
    why: 'The ways this project reviews — a charter and a profile each. Two or more switches the triage on.',
  },
  {
    path: 'review.defaultMode',
    type: 'string',
    access: 'plain',
    why: 'The mode a review falls back to when the triage could not answer. Name the thorough one.',
  },
  {
    path: 'review.routingCharterFile',
    type: 'string',
    access: 'plain',
    why: 'A file in the repository saying how to choose between the modes, read by the triage agent.',
  },
  {
    path: 'localRun.instruction',
    type: 'text',
    access: 'plain',
    why: 'How this project’s application is started on your machine. Empty means nothing is startable.',
  },
  {
    path: 'localRun.stopInstruction',
    type: 'text',
    access: 'plain',
    why: 'How it is stopped again. Empty means a stop kills the session but not what it started.',
  },
  {
    path: 'localRun.resumeInstruction',
    type: 'text',
    access: 'plain',
    why: 'How an environment the harness was holding is brought back after a restart. Empty means it is not.',
  },
  {
    path: 'localRun.resumeWindowMs',
    type: 'number',
    access: 'plain',
    why: 'How long after the harness went down a run may still be brought back. 0 means no bound.',
  },
  {
    path: 'localRun.refreshInstruction',
    type: 'text',
    access: 'plain',
    why: 'What a running environment does to pick up new code once its checkout has moved — rebuild, migrate, restart. Empty means it is only told what moved.',
  },
  {
    path: 'localRun.url',
    type: 'string',
    access: 'plain',
    why: 'Where the application lands once it is up, drawn as a link beside the run.',
  },
  {
    path: 'localValidation.instruction',
    type: 'text',
    access: 'plain',
    why: 'What a validating agent is told about reaching your environment — which URL is which, how to sign in, what to leave alone. Never a secret: it is readable here and a project layer commits it.',
  },
  {
    path: 'localValidation.browser',
    type: 'json',
    access: 'plain',
    why: 'The MCP server that gives a validating agent a browser — {command, args}, with {outputDir} and {profileDir} filled in per run. null runs validations without one, and steps that need a screen are reported blocked.',
  },
  {
    path: 'validation.desktopSocketPath',
    type: 'string',
    access: 'advanced',
    why: 'Where the desktop channel binds.',
  },
  {
    path: 'validation.desktopCredentialPath',
    type: 'string',
    access: 'advanced',
    why: 'Where the desktop channel’s minted token is written.',
  },
  {
    path: 'spendBurn.enabled',
    type: 'boolean',
    access: 'plain',
    why: 'Watch a run spending past what its kind costs.',
  },
  {
    path: 'spendBurn.multiple',
    type: 'number',
    access: 'plain',
    why: 'How many times the typical cost counts as burning. Must be above 1.',
  },
  {
    path: 'spendBurn.minimumRuns',
    type: 'number',
    access: 'plain',
    why: 'How many comparable runs are needed before the watch has an opinion.',
  },
  { path: 'spendBurn.floorUsd', type: 'number', access: 'plain', why: 'Spend below which nothing is ever flagged.' },
  {
    path: 'spendBurn.ceilingUsd',
    type: 'number',
    access: 'plain',
    why: 'Spend above which a run is flagged whatever its comparables say.',
  },
  {
    path: 'runway.enabled',
    type: 'boolean',
    access: 'plain',
    why: 'Say when the queue of work is running out.',
  },
  {
    path: 'runway.warnHours',
    type: 'number',
    access: 'plain',
    why: 'Hours of queued work below which you are told.',
  },
  {
    path: 'runway.clearHours',
    type: 'number',
    access: 'plain',
    why: 'Hours the queue must be back above before the notice clears. Must be above warnHours.',
  },
  {
    path: 'runway.minimumRuns',
    type: 'number',
    access: 'plain',
    why: 'How many finished goals are needed before a typical goal length is known.',
  },
  // The two pets keys there are, and both are switches. The rates are constants in
  // `src/pets/rules.ts` and this page cannot reach them.
  {
    path: 'pets.enabled',
    type: 'boolean',
    access: 'plain',
    why: 'Creatures that hatch from what you do in the cockpit.',
  },
  {
    path: 'pets.visible',
    type: 'boolean',
    access: 'plain',
    why: 'Show the vivarium and its tab. Off keeps hatching them, out of sight.',
  },
  { path: 'selfUpdate.enabled', type: 'boolean', access: 'plain', why: 'Check this build against its upstream.' },
  { path: 'selfUpdate.remote', type: 'string', access: 'plain', why: 'The remote the build is checked against.' },
  { path: 'selfUpdate.branch', type: 'string', access: 'plain', why: 'The branch the build is checked against.' },
  {
    path: 'selfUpdate.checkIntervalMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How often the upstream tip is read.',
  },
  {
    path: 'selfUpdate.autoUpdate',
    type: 'boolean',
    access: 'plain',
    why: 'Take an update without being asked: drain, then hand off when the fleet is clear.',
  },
  {
    path: 'selfUpdate.drainDeadlineMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How long an automatic drain waits before interrupting what is left. Zero waits forever.',
  },
  {
    path: 'selfUpdate.projectAutoPull',
    type: 'boolean',
    access: 'plain',
    why: 'Fast-forward the worked checkout on its own whenever it cleanly can. Off asks on the rail instead.',
  },
  {
    path: 'selfUpdate.snoozeMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How long Snooze hides an update ask on the rail.',
  },
  {
    path: 'ci.checks',
    type: 'json',
    access: 'plain',
    why: 'What a red check gets, first match wins — so the order is the policy.',
  },

  // ---- Paths -------------------------------------------------------------
  {
    path: 'repoRoot',
    type: 'string',
    access: 'advanced',
    env: 'LUBBDUBB_REPO_ROOT',
    why: 'The git repository worktrees are cut from.',
  },
  {
    path: 'defaultBranch',
    type: 'string',
    access: 'advanced',
    why: 'The integration branch. Not auto-detected.',
  },
  { path: 'worktreeRoot', type: 'string', access: 'advanced', why: 'Root for the pool of worktree slot directories.' },
  { path: 'deskRoot', type: 'string', access: 'advanced', why: 'Scratch root for desk agents.' },
  { path: 'attachmentRoot', type: 'string', access: 'advanced', why: 'Where brief attachments are written.' },
  { path: 'validationRoot', type: 'string', access: 'advanced', why: 'Where validation resources are written.' },
  {
    path: 'localRunRoot',
    type: 'string',
    access: 'advanced',
    why: 'The local run’s own checkout. Must not be under worktreeRoot — the pool would claim it as a slot.',
  },
  { path: 'promptTemplatesDir', type: 'string', access: 'advanced', why: 'Where prompt-book overrides are read from.' },
  {
    path: 'docsFolderPrefix',
    type: 'json',
    access: 'advanced',
    why: 'Path prefixes an agent’s artifacts may be read from.',
  },
  {
    path: 'dbPath',
    type: 'string',
    access: 'advanced',
    env: 'LUBBDUBB_DB',
    why: 'SQLite file.',
  },

  // ---- Server ------------------------------------------------------------
  { path: 'port', type: 'number', access: 'advanced', env: 'PORT', why: 'HTTP/WS port.' },
  {
    path: 'host',
    type: 'string',
    access: 'advanced',
    env: 'LUBBDUBB_HOST',
    why: 'Bind address. Anything off-loopback requires auth.enabled.',
  },
  {
    path: 'auth.enabled',
    type: 'boolean',
    access: 'advanced',
    why: 'Require a bearer token on /api/* and /ws.',
  },
  {
    path: 'auth.tokenFile',
    type: 'string',
    access: 'advanced',
    why: 'Where a minted token is persisted. Ignored when LUBBDUBB_TOKEN is set.',
  },
  // The inbound ingress. No secret and no on switch here: both live in the
  // environment, and setting one is what turns the endpoint on. These four are the
  // bounds it runs under. → `docs/spec/30-ingress.md#turning-it-on`
  {
    path: 'ingress.debounceMs',
    type: 'number',
    ms: true,
    access: 'advanced',
    why: 'How long a burst of webhook deliveries settles before one cycle fires.',
  },
  {
    path: 'ingress.minCycleGapMs',
    type: 'number',
    ms: true,
    access: 'advanced',
    why: 'Floor between two cycles a delivery may cause. The one lever on what an inbound flood can spend of this fleet’s provider budget.',
  },
  {
    path: 'ingress.requestsPerMinute',
    type: 'number',
    access: 'advanced',
    why: 'Deliveries accepted per minute across the whole endpoint before a 429. Keyed to the endpoint, not the caller: a webhook arrives from a whole address range.',
  },
  {
    path: 'ingress.maxBodyBytes',
    type: 'number',
    access: 'advanced',
    why: 'Largest delivery body read before a 413. Bounds the work an unverified caller can buy.',
  },
];

const BY_PATH = new Map(CONFIG_FIELDS.map((field) => [field.path, field]));

/** The declaration for one dotted path, or undefined for a path nothing declares. */
export function configField(path: string): ConfigField | undefined {
  return BY_PATH.get(path);
}

/**
 * Read a dotted path out of a config object; `undefined` for an unset optional. Takes
 * a `Partial<Config>` because a *layer* is read through it too.
 */
export function readPath(config: Partial<Config>, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * The value to *offer* for an unset field, or undefined where there is nothing whole
 * to offer: every part must resolve to a non-empty string, since a half-typed
 * suggestion is one an operator can accept. One join rule for both surfaces that
 * offer a value. → `docs/spec/28-cross-fleet-pool.md#configuration`
 */
export function suggestedValue(field: ConfigField, config: Partial<Config>): string | undefined {
  const suggest = field.suggest;
  if (!suggest) return undefined;
  const parts = suggest.join.map((path) => readPath(config, path));
  if (!parts.every((part) => typeof part === 'string' && part !== '')) return undefined;
  return parts.join(suggest.with);
}

/**
 * The environment variable currently overriding this field, if any. Read from
 * `process.env` at call time, never captured — `loadDeploymentConfig` reads it live.
 */
export function envOverride(field: ConfigField): string | undefined {
  return field.env && process.env[field.env] ? field.env : undefined;
}

/**
 * Why this value cannot be saved into this field, or null. Checked here rather than
 * in the widget, because the route is what anything else reaches. It deliberately
 * does not check *meaning* — that is `loadConfig`'s, exercised by building the config
 * the save would produce.
 */
export function fieldValueRefusal(field: ConfigField, value: unknown): string | null {
  switch (field.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field.path} must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field.path} must be true or false`;
    // `text` is a string all the way to the file; the union member only picks the
    // widget. One arm for both, so the rule cannot drift.
    case 'string':
    case 'text':
      return typeof value === 'string' ? null : `${field.path} must be a string`;
    case 'enum':
      return typeof value === 'string' && field.options?.includes(value)
        ? null
        : `${field.path} must be one of ${field.options?.join(', ')}`;
    case 'stringList':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? null
        : `${field.path} must be a list of strings`;
    case 'json':
      // Shaped by its own validator in `loadConfig`; only an unserialisable value is refused here.
      return value === undefined ? `${field.path} must be a value` : null;
    case 'colourMap':
      // A colour is drawn straight into a `style`, so the shape is refused here rather
      // than silently skipped by the renderer. `stateColour` still guards the read.
      return isColourMap(value) ? null : `${field.path} must map a state to a #rrggbb colour`;
  }
}

/** `#rrggbb`, the one form the cockpit's picker writes. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/**
 * A state → colour map, checked leaf by leaf. The same form `web/src/stateColour.ts`
 * reads, stated twice deliberately — this is the one that decides.
 */
function isColourMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string' && HEX_COLOUR.test(entry));
}

/**
 * Every top-level key of a default config, for the test that keeps this table honest:
 * a key added without a declaration here fails `npm run check` rather than quietly
 * becoming un-editable.
 */
export function declaredTopLevelKeys(): Set<string> {
  return new Set(CONFIG_FIELDS.map((field) => topSegment(field.path)));
}

/** The top-level config key a dotted path belongs to. */
export function topSegment(path: string): string {
  return path.split('.')[0] ?? path;
}

/** The keys a default config carries, for the same test. */
export function configTopLevelKeys(): Set<string> {
  return new Set(Object.keys(defaultConfig()));
}
