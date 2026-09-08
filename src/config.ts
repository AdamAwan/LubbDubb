import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { IntegrationSelection } from './integrations/integration.js';
import { DEFAULT_CONTAINER_TYPES, DEFAULT_PARENTED_TYPES } from './issueRelations.js';
import { DEFAULT_PLANNING, type PlanningPolicy } from './plans/planning.js';
import { DEFAULT_BURN, validateBurnPolicy, type BurnPolicy } from './spendBurn.js';
import { DEFAULT_RUNWAY, validateRunwayPolicy, type RunwayPolicy } from './supply/runway.js';
import type { SelfUpdatePolicy } from './selfUpdate/upgradePlan.js';
import { DEFAULT_VALIDATION, type ValidationPolicy } from './validation/policy.js';
import { DEFAULT_EJECTION, type EjectionPolicy } from './ejection/policy.js';
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

// → docs/spec/02-configuration.md

export interface Config {
  heartbeatIntervalMs: number;
  idleHeartbeatIntervalMs: number;
  hotReadMaxAgeMs: number;
  coldReadMaxAgeMs: number;
  maxConcurrentAgents: number;
  startPaused: boolean;
  sendPrRepliesWithoutApproval: boolean;
  whitelistedApprovals: WhitelistRule[];
  userId?: string;
  ownWorkOnly: boolean;
  integrations: IntegrationSelection;
  fleetId?: string;
  pool?: PoolConfig;
  github?: GitHubConfig;
  azureDevOps?: AzureDevOpsConfig;
  labelPrefix: string;
  issuePriorityLabels: Record<string, number>;
  issueDefaultPriority: number;
  issueSequencing: IssueSequencing;
  issueSequenceMaxChildren: number;
  issueStateColours: Record<string, string>;
  issueBoardStates: string[];
  issuePickupStates?: string[];
  issueInReviewState?: string;
  issueInProgressState?: string;
  issueContainerTypes: string[];
  issueParentedTypes: string[];
  issueFilingTypes: string[];
  issueBugType?: string;
  planning: PlanningPolicy;
  featureBoard: boolean;
  spendBurn: BurnPolicy;
  runway: RunwayPolicy;
  pets: PetPolicy;
  selfUpdate: SelfUpdatePolicy;
  validation: ValidationPolicy;
  ejection: EjectionPolicy;
  review: PrReviewPolicy;
  localRun: LocalRunPolicy;
  localValidation: LocalValidationPolicy;
  closedPrWindowMs: number;
  obstacleDormantMs: number;
  environments: EnvironmentConfig[];
  environmentProbeIntervalMs: number;
  environmentHealthIntervalMs: number;
  watchIntervalMs: number;
  ci: CiPolicy;
  upNextOverrideTtlMs: number;
  agentMode: 'stream' | 'raw';
  agentPermissionMode: string;
  agentModels?: AgentModels;
  agentAllowedTools: string[];
  agentPromptDelayMs: number;
  agentSubmitDelayMs: number;
  agentWaitingPatterns: string[];
  agentStallNudges: number;
  agentStallParkMs: number;
  agentStallExtendMs: number;
  agentSilenceParkMs: number;
  agentResumeAttempts: number;
  mcpArgsRetentionDays: number;
  claudeCommand: string;
  claudeArgs: string[];
  docsFolderPrefix?: string | string[];
  promptTemplatesDir: string;
  worktreeRoot: string;
  deskRoot: string;
  attachmentRoot: string;
  validationRoot: string;
  localRunRoot: string;
  repoRoot: string;
  defaultBranch: string;
  dbPath: string;
  port: number;
  host: string;
  auth: AuthConfig;
  ingress: IngressBounds;
}

interface AuthConfig {
  enabled: boolean;
  tokenFile: string;
}

interface IngressBounds {
  debounceMs: number;
  minCycleGapMs: number;
  requestsPerMinute: number;
  maxBodyBytes: number;
}

export interface GitHubConfig {
  owner: string;
  repo: string;
}

export interface AzureDevOpsConfig {
  organization: string;
  project: string;
  repository: string;
  filters?: {
    workItemTag?: string;
  };
  policyChecks?: PolicyCheckModes;
}

interface PoolConfig {
  project?: string;
  remote?: string;
  branch?: string;
  path?: string;
  digestIntervalMs?: number;
}

export interface WhitelistRule {
  match: string;
  response: string;
}

const DEFAULTS: Config = {
  heartbeatIntervalMs: 30 * 1000,
  idleHeartbeatIntervalMs: 5 * 60 * 1000,
  hotReadMaxAgeMs: DEFAULT_READ_LANES.hotMaxAgeMs,
  coldReadMaxAgeMs: DEFAULT_READ_LANES.coldMaxAgeMs,
  maxConcurrentAgents: 3,
  startPaused: false,
  sendPrRepliesWithoutApproval: true,
  whitelistedApprovals: [],
  ownWorkOnly: true,
  integrations: { sourceControl: 'fake', issues: 'fake', pool: 'fake' },
  pool: {},
  labelPrefix: 'lubbdubb',
  issuePriorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  issueDefaultPriority: 2,
  issueSequencing: 'off',
  issueSequenceMaxChildren: DEFAULT_SEQUENCE_MAX_CHILDREN,
  issueStateColours: {},
  issueBoardStates: [],
  issueContainerTypes: [...DEFAULT_CONTAINER_TYPES],
  issueParentedTypes: [...DEFAULT_PARENTED_TYPES],
  issueFilingTypes: [...DEFAULT_FILING_TYPES],
  planning: DEFAULT_PLANNING,
  featureBoard: false,
  spendBurn: DEFAULT_BURN,
  runway: DEFAULT_RUNWAY,
  pets: { enabled: true, visible: true },
  selfUpdate: {
    enabled: true,
    remote: 'origin',
    branch: 'main',
    checkIntervalMs: 15 * 60 * 1000,
    autoUpdate: false,
    drainDeadlineMs: 2 * 60 * 60 * 1000,
    projectAutoPull: true,
    snoozeMs: 30 * 60 * 1000,
  },
  validation: DEFAULT_VALIDATION,
  ejection: DEFAULT_EJECTION,
  review: DEFAULT_PR_REVIEW,
  localRun: DEFAULT_LOCAL_RUN,
  localValidation: DEFAULT_LOCAL_VALIDATION,
  closedPrWindowMs: 6 * 60 * 60 * 1000,
  obstacleDormantMs: 7 * 24 * 60 * 60 * 1000,
  environments: [],
  environmentProbeIntervalMs: 5 * 60 * 1000,
  environmentHealthIntervalMs: 5 * 60 * 1000,
  watchIntervalMs: 30 * 60 * 1000,
  ci: { checks: [] },
  upNextOverrideTtlMs: 7 * 24 * 60 * 60 * 1000,
  agentMode: 'stream',
  agentPermissionMode: 'acceptEdits',
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
  ingress: { debounceMs: 1_000, minCycleGapMs: 5_000, requestsPerMinute: 600, maxBodyBytes: 1_048_576 },
};

function resolveRootPaths(merged: Config): void {
  merged.repoRoot = resolve(process.cwd(), merged.repoRoot);

  merged.worktreeRoot = resolve(merged.repoRoot, merged.worktreeRoot);
  merged.deskRoot = resolve(merged.repoRoot, merged.deskRoot);
  merged.attachmentRoot = resolve(merged.repoRoot, merged.attachmentRoot);
  merged.validationRoot = resolve(merged.repoRoot, merged.validationRoot);
  merged.localRunRoot = resolve(merged.repoRoot, merged.localRunRoot);

  merged.promptTemplatesDir = resolve(merged.repoRoot, merged.promptTemplatesDir);
}

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
  merged.ci = { checks: overrides.ci?.checks ?? DEFAULTS.ci.checks };
  merged.environments = overrides.environments ?? DEFAULTS.environments;
  return merged;
}

export function baselineConfig(project: Partial<Config> = {}): Config {
  return mergeConfig(project);
}

export function defaultConfig(): Config {
  return mergeConfig();
}

const REMOVED_KEYS: Readonly<Record<string, string>> = {
  dispatcher:
    'the "claude" dispatcher was removed and the rule dispatcher is the only one, so there is nothing left to select',
  steeringPriorities: 'it was only ever injected into the removed "claude" dispatcher\'s prompt and now steers nothing',
  autoSend:
    'it gated on a confidence threshold that resolved between two constants and measured nothing — if you want the harness to send a drafted reply without asking, set "sendPrRepliesWithoutApproval": true, which is replies only and has no threshold; a merge is still authorized per pull request by landing a stack',
};

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

function validateWorkItemStates(merged: Config): void {
  const pickup = merged.issuePickupStates ?? [];
  const named = [
    ['issueInProgressState', merged.issueInProgressState],
    ['issueInReviewState', merged.issueInReviewState],
  ].filter(([, state]) => state !== undefined && state !== '');
  if (named.length > 0 && pickup.length === 0) {
    throw new Error(
      `Refusing to start: ${named.map(([key]) => key).join(' and ')} ${named.length > 1 ? 'name states' : 'names a state'} ` +
        'to move work items to, but issuePickupStates is empty — the rules that move them are off, so the board ' +
        'never leaves the state its items are filed in. Name the states work starts in (e.g. ["New"]), or drop ' +
        'the transition keys.',
    );
  }
  const inReview = merged.issueInReviewState;
  if (inReview !== undefined && pickup.includes(inReview)) {
    throw new Error(
      `Refusing to start: issueInReviewState is "${inReview}", which is also in issuePickupStates. An item parked ` +
        'there still reads as pickup-eligible, so the harness writes that same state to the tracker on every ' +
        'pulse for as long as its pull request is open. Take it out of issuePickupStates.',
    );
  }
}

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

export const DEEP_MERGED_BLOCKS = [
  'integrations',
  'planning',
  'pets',
  'spendBurn',
  'runway',
  'selfUpdate',
  'validation',
  'ejection',
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

const DEEP_MERGED_SUBBLOCKS: Partial<Record<(typeof DEEP_MERGED_BLOCKS)[number], readonly string[]>> = {
  azureDevOps: ['filters'],
};

function mergeLayers(lower: Partial<Config>, upper: Partial<Config>): Partial<Config> {
  const merged: Partial<Config> = { ...lower, ...upper };
  for (const key of DEEP_MERGED_BLOCKS) {
    if (lower[key] === undefined && upper[key] === undefined) continue;
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

export function loadDeploymentConfig(overrides: Partial<Config> = {}): Config {
  const filePath = configFilePath();
  const fromFile = existsSync(filePath) ? readFileLayer(readFileSync(filePath, 'utf8'), filePath) : {};
  return loadConfig(deploymentLayers(fromFile, overrides));
}

export function configFilePath(): string {
  return resolve(process.cwd(), 'lubbdubb.config.json');
}

export function projectConfigFilePath(repoRoot: string): string {
  return resolve(repoRoot, 'lubbdubb.project.json');
}

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

function deploymentLayers(fromFile: Partial<Config>, overrides: Partial<Config>): Partial<Config> {
  const operator = mergeLayers(mergeLayers(fromFile, envLayer()), overrides);
  const repoRoot = resolve(process.cwd(), operator.repoRoot ?? DEFAULTS.repoRoot);
  return mergeLayers(projectConfigLayer(projectConfigFilePath(repoRoot)), operator);
}

function envLayer(): Partial<Config> {
  const fromEnv: Partial<Config> = {};
  if (process.env.PORT) fromEnv.port = Number(process.env.PORT);
  if (process.env.LUBBDUBB_HOST) fromEnv.host = process.env.LUBBDUBB_HOST;
  if (process.env.LUBBDUBB_DB) fromEnv.dbPath = process.env.LUBBDUBB_DB;
  if (process.env.LUBBDUBB_REPO_ROOT) fromEnv.repoRoot = process.env.LUBBDUBB_REPO_ROOT;
  return fromEnv;
}

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

export function loadConfigFromText(text: string, filePath = configFilePath()): Config {
  return loadConfig(deploymentLayers(readFileLayer(text, filePath), {}));
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const merged = mergeConfig(overrides);

  validateAgentMode(merged);

  validateCiPolicy(merged.ci);

  if (merged.azureDevOps?.policyChecks) validatePolicyCheckModes(merged.azureDevOps.policyChecks);

  validateAgentModels(merged.agentModels);

  validateBurnPolicy(merged.spendBurn);

  validateRunwayPolicy(merged.runway);

  validateEnvironments(merged.environments);

  validateWorkItemStates(merged);

  if (merged.host !== '127.0.0.1' && merged.host !== 'localhost' && merged.host !== '::1' && !merged.auth.enabled) {
    throw new Error(
      `Refusing to start: host "${merged.host}" is reachable off this machine and auth.enabled is false. ` +
        `The cockpit can queue jobs, which spawn agents with write access to your repo. ` +
        `Either bind 127.0.0.1 (the default) or leave auth on.`,
    );
  }

  if (pathsOverlap(merged.worktreeRoot, merged.localRunRoot)) {
    throw new Error(
      `Refusing to start: localRunRoot (${merged.localRunRoot}) overlaps worktreeRoot (${merged.worktreeRoot}). ` +
        `The pool counts every registered worktree under its root whatever the directory is called, so the local ` +
        `run's checkout would be leased to an agent and wiped. Point localRunRoot somewhere outside the pool.`,
    );
  }

  validatePool(merged);
  validateReview(merged);

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

function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const inside = (root: string, path: string): boolean => {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  return inside(a, b) || inside(b, a);
}
