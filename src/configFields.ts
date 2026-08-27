import { defaultConfig, type Config } from './config.js';

/**
 * What every configurable leaf *is* — the one declaration the config form, the
 * save validator, the live-apply switch and the reset action all read from.
 *
 * `RunningConfigEntry` carries `value: unknown`, which is enough to draw a value
 * back and nothing like enough to draw a control for it: a form generator has no
 * way to tell a number from a duration from a three-member enum, and four
 * consumers each guessing separately is four places to disagree. So the type, the
 * members, the reach and the reason live here once.
 *
 * What is deliberately *not* here is liveness. Whether saving a key takes effect
 * now is decided by whether `configApply.ts` has an arm that re-seats whoever
 * holds it — a fact about the wiring, not a claim a table can make. A list here
 * saying "these read late so they're fine" would be right the day it was written
 * and wrong the day someone hoists `config.heartbeatIntervalMs` into a const,
 * with nothing red. → `docs/spec/02-configuration.md#liveness`
 */
/**
 * `text` is `string` with room to breathe — the same value, drawn as a textarea.
 *
 * Its own member rather than a flag on `string` because the form switches on this
 * union and a widget hint that some string fields ignore is a third state to keep
 * straight. What earns it: `localRun.instruction` is several sentences an operator
 * writes while trying to get their environment up, and a single-line input for it
 * is a field they cannot read back what they typed into.
 */
export type ConfigFieldType = 'number' | 'boolean' | 'string' | 'text' | 'enum' | 'stringList' | 'json' | 'colourMap';

/**
 * How far an operator has to reach to edit a field.
 *
 * `advanced` is not "harder", it is "this one can lock you out of the cockpit or
 * point the fleet at the wrong repository" — Paths, Server, and the agent command
 * line. `fileOnly` is for a field no form should offer: `whitelistedApprovals`
 * types text into an agent's session on a substring match, which is a thing to
 * write deliberately in a file rather than to fill in beside twenty other rows.
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
   * The environment variable that beats the file for this key. A field carrying
   * one is drawn as overridden and refused for edit whenever it is set: the file
   * would be written and nothing would change, which is the silent kind of
   * failure this repo refuses to ship.
   */
  env?: string;
  /** A duration in milliseconds, so the cockpit can say "5m" beside the number. */
  ms?: boolean;
  /**
   * The key whose value makes this one required, and the one value of it that
   * does not — `fleetId` is required while `integrations.pool` is anything but
   * `fake`.
   *
   * Declared here rather than judged in the browser for {@link ConfigField}'s
   * reason, with one addition the other members do not have: the form has to
   * answer the question against what is **staged**, not against what is running.
   * An operator picking the pool provider and saving has already written a config
   * the next boot refuses (`validatePool` in `config.ts`) — the refusal arrives as a 400 on
   * a form that offered no field to fix it, since an unset optional is not drawn.
   * So the declaration ships, the form evaluates it over the edit in front of it,
   * and the key is drawn even while unset.
   */
  requiredWhen?: ConfigFieldRequirement;
  /**
   * The keys to join into a value to *offer* for an unset field, and what to join
   * them with. An offer and never a derivation: it is drawn beside the empty
   * field as something to accept, and nothing writes it on the operator's behalf.
   * → `docs/spec/28-cross-fleet-pool.md#configuration`
   */
  suggest?: ConfigFieldSuggestion;
}

/** The key another key's requirement hangs on, and the one value of it that lifts it. */
export interface ConfigFieldRequirement {
  path: string;
  unless: string;
}

/**
 * The keys to join into a suggested value, and what to join them with.
 *
 * Unexported: `suggestedValue` below is the one reader, so nothing outside this
 * module names the shape.
 */
interface ConfigFieldSuggestion {
  join: readonly string[];
  with: string;
}

/**
 * Every leaf, in no particular order — display order is `GROUPS` in
 * `server/runningConfig.ts`, which groups by the first path segment.
 *
 * A `json` field is edited whole because it has no fixed shape to draw: an
 * ordered rule list where the order *is* the semantics (`ci.checks`), or a map
 * whose keys the operator invents (`issuePriorityLabels`, `agentModels`).
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
    path: 'environments',
    type: 'json',
    // `fileOnly` for `whitelistedApprovals`' reason and not because the shape is
    // awkward: each entry is a shell command the harness runs on a schedule, which
    // is a thing to write deliberately in a file rather than to fill in beside
    // twenty other rows.
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
    options: ['stream', 'pty', 'raw'],
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
    why: 'Gap between a PTY message and the carriage return that submits it.',
  },
  {
    path: 'agentIdleWaitMs',
    type: 'number',
    ms: true,
    access: 'plain',
    why: 'How long a silent agent is left before it is read as waiting.',
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
    path: 'knowledgeBlockChars',
    type: 'number',
    access: 'plain',
    why: 'Cap on the knowledge block an agent is launched with. Read at every launch.',
  },
  {
    path: 'knowledgeScopeStaleDays',
    type: 'number',
    access: 'plain',
    why: 'How long a check scope may match nothing before the Knowledge page says so. A reading — nothing is demoted by it. 0 turns it off.',
  },
  {
    path: 'knowledgeColdDays',
    type: 'number',
    access: 'plain',
    why: 'How long a proposal nobody agreed with and nobody asked for is drawn before the Knowledge page folds it away. A reading — nothing is demoted by it. 0 turns it off.',
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
  {
    path: 'sessionTranscriptRoot',
    type: 'string',
    access: 'advanced',
    why: 'Where agent session transcripts are read from.',
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
    path: 'localRun.url',
    type: 'string',
    access: 'plain',
    why: 'Where the application lands once it is up, drawn as a link beside the run.',
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
  // The two pets keys there are, and both are switches. The rates used to sit
  // here too, and each of them was a way of hatching a pet without doing anything
  // — so they are constants in `src/pets/rules.ts` now, and this page cannot reach
  // them.
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
];

const BY_PATH = new Map(CONFIG_FIELDS.map((field) => [field.path, field]));

/** The declaration for one dotted path, or undefined for a path nothing declares. */
export function configField(path: string): ConfigField | undefined {
  return BY_PATH.get(path);
}

/**
 * Read a dotted path out of a config object. `undefined` for an unset optional.
 *
 * Takes a `Partial<Config>` because a *layer* is read through it too — the
 * question "did the project's file set this key" is answered by walking the layer
 * the file parsed to, and a resolved config cannot answer it.
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
 * The value to *offer* for an unset field, or undefined where there is nothing
 * whole to offer.
 *
 * Every part must resolve to a non-empty string. `alice@` is not a suggestion, it
 * is a half-typed one — and the operator who accepts it publishes under an address
 * that reads like a mistake to every other fleet in the pool.
 *
 * One join rule, read by both surfaces that offer a value: the config page's
 * empty field (`src/server/runningConfig.ts`) and the **Needs you** row that asks
 * for `fleetId` (`src/setup/reading.ts`). A second copy would be free to offer a
 * different address from the one the field beside it proposes.
 * → `docs/spec/28-cross-fleet-pool.md#configuration`
 */
export function suggestedValue(field: ConfigField, config: Partial<Config>): string | undefined {
  const suggest = field.suggest;
  if (!suggest) return undefined;
  const parts = suggest.join.map((path) => readPath(config, path));
  if (!parts.every((part) => typeof part === 'string' && part !== '')) return undefined;
  return parts.join(suggest.with);
}

/**
 * The environment variable currently overriding this field, if any.
 *
 * Read from `process.env` at call time rather than captured, because the answer
 * is about the process the operator is looking at — and a captured copy is one
 * more thing that can disagree with `loadDeploymentConfig`, which reads it live.
 */
export function envOverride(field: ConfigField): string | undefined {
  return field.env && process.env[field.env] ? field.env : undefined;
}

/**
 * Why this value cannot be saved into this field, or null.
 *
 * The loader does not type-check the file — `loadDeploymentConfig` casts a parsed
 * object to `Partial<Config>`, so `"port": "4300"` boots and fails later, at the
 * point something tries to listen on a string. A form that can only emit values
 * of the declared type is a real improvement on that, and this is where it is
 * made true rather than in the widget: a widget checks what it drew, and the
 * route is what anything else reaches.
 *
 * What it deliberately does not check is *meaning* — whether a burn multiple is
 * above 1, whether a CI rule's `onFailure` is a real routing. Those are
 * `loadConfig`'s, and a save is validated by building the config it would produce
 * so they answer for themselves. Two checks for one question is how two checks
 * come to disagree.
 */
export function fieldValueRefusal(field: ConfigField, value: unknown): string | null {
  switch (field.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field.path} must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field.path} must be true or false`;
    // `text` is a string all the way to the file — the union member only tells the
    // form to draw a textarea, so there is nothing extra to refuse. One arm for
    // both rather than two identical ones: two would be two places for the same
    // rule to drift.
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
      // Shipped whole and shaped by its own validator in `loadConfig`. The only
      // thing left to refuse here is a value JSON cannot carry at all.
      return value === undefined ? `${field.path} must be a value` : null;
    case 'colourMap':
      // A colour is drawn straight into a `style`, so the shape is refused here
      // rather than left to the renderer to skip: a map half of whose values do
      // nothing is a map an operator reads as broken with nothing saying why.
      // `stateColour` still guards the read, for the file this route never saw.
      return isColourMap(value) ? null : `${field.path} must map a state to a #rrggbb colour`;
  }
}

/** `#rrggbb`, the one form the cockpit's picker writes. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/**
 * A state → colour map, checked leaf by leaf.
 *
 * The same form `web/src/stateColour.ts` reads, stated twice for `parseValue`'s
 * reason: that one is about the keystroke in front of the operator, and this one
 * is about anything that reaches the route. This is the one that decides.
 */
function isColourMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string' && HEX_COLOUR.test(entry));
}

/**
 * Every top-level key of a default config, for the test that keeps this table
 * honest: a config key added without a declaration here fails `npm run check`
 * rather than quietly becoming un-editable.
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
