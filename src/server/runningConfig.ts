import { baselineConfig, type Config } from '../config.js';
import { isLiveField } from '../configApply.js';
import {
  CONFIG_FIELDS,
  configField,
  envOverride,
  readPath,
  suggestedValue,
  type ConfigFieldAccess,
  type ConfigFieldRequirement,
  type ConfigFieldType,
} from '../configFields.js';

// → docs/spec/02-configuration.md

export interface RunningConfigEntry {
  path: string;
  value: unknown;
  isDefault: boolean;
  fromProject?: true;
  type: ConfigFieldType;
  options?: readonly string[];
  access: ConfigFieldAccess;
  live: boolean;
  env: string | null;
  why: string;
  ms?: boolean;
  requiredWhen?: ConfigFieldRequirement;
  suggestion?: string;
}

export interface RunningConfigGroup {
  title: string;
  entries: RunningConfigEntry[];
}

const GROUPS: readonly { title: string; keys: readonly (keyof Config)[] }[] = [
  {
    title: 'Dispatch',
    keys: [
      'heartbeatIntervalMs',
      'idleHeartbeatIntervalMs',
      'hotReadMaxAgeMs',
      'coldReadMaxAgeMs',
      'maxConcurrentAgents',
      'startPaused',
      'sendPrRepliesWithoutApproval',
      'closedPrWindowMs',
      'upNextOverrideTtlMs',
    ],
  },
  {
    title: 'Agents',
    keys: [
      'agentMode',
      'agentPermissionMode',
      'agentModels',
      'agentAllowedTools',
      'agentPromptDelayMs',
      'agentSubmitDelayMs',
      'agentWaitingPatterns',
      'agentStallNudges',
      'agentStallParkMs',
      'agentStallExtendMs',
      'agentSilenceParkMs',
      'agentResumeAttempts',
      'mcpArgsRetentionDays',
      'whitelistedApprovals',
      'claudeCommand',
      'claudeArgs',
    ],
  },
  {
    title: 'Integrations',
    keys: [
      'integrations',
      'userId',
      'ownWorkOnly',
      'github',
      'azureDevOps',
      'fleetId',
      'pool',
      'labelPrefix',
      'issuePriorityLabels',
      'issueStateColours',
      'issueBoardStates',
      'issueDefaultPriority',
      'issueSequencing',
      'issueSequenceMaxChildren',
      'issuePickupStates',
      'issueInReviewState',
      'issueInProgressState',
      'issueContainerTypes',
      'issueParentedTypes',
      'issueFilingTypes',
      'issueBugType',
    ],
  },
  {
    title: 'Features',
    keys: [
      'featureBoard',
      'planning',
      'validation',
      'ejection',
      'review',
      'spendBurn',
      'runway',
      'selfUpdate',
      'ci',
      'pets',
      'localRun',
      'localValidation',
      'environments',
      'environmentProbeIntervalMs',
      'environmentHealthIntervalMs',
      'watchIntervalMs',
      'obstacleDormantMs',
    ],
  },
  {
    title: 'Paths',
    keys: [
      'repoRoot',
      'defaultBranch',
      'worktreeRoot',
      'deskRoot',
      'attachmentRoot',
      'validationRoot',
      'localRunRoot',
      'promptTemplatesDir',
      'docsFolderPrefix',
      'dbPath',
    ],
  },
  { title: 'Server', keys: ['port', 'host', 'auth', 'ingress'] },
];

export function groupedTopLevelKeys(): ReadonlySet<string> {
  return new Set(GROUPS.flatMap((group) => group.keys as readonly string[]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function flatten(
  value: unknown,
  baseline: unknown,
  prefix: string,
  out: RunningConfigEntry[],
  project: Partial<Config>,
): void {
  if (value === undefined) return;
  if (isPlainObject(value)) {
    const base = isPlainObject(baseline) ? baseline : undefined;
    for (const key of Object.keys(value)) {
      flatten(value[key], base?.[key], prefix ? `${prefix}.${key}` : key, out, project);
    }
    return;
  }
  out.push({
    path: prefix,
    value,
    isDefault: baseline !== undefined && sameValue(value, baseline),
    ...(readPath(project, prefix) !== undefined ? { fromProject: true as const } : {}),
    type: 'json',
    access: 'fileOnly',
    live: false,
    env: null,
    why: 'Not a key this build declares — edit it in the file, or delete it.',
  });
}

function entryFor(path: string, config: Config, baseline: Config, project: Partial<Config>): RunningConfigEntry | null {
  const field = configField(path);
  /* istanbul ignore next — callers iterate CONFIG_FIELDS, so the lookup always hits. */
  if (!field) return null;
  const held = readPath(config, path);
  if (held === undefined && !field.requiredWhen) return null;
  const value = held === undefined ? '' : held;
  const base = held === undefined ? value : readPath(baseline, path);
  const suggestion = suggestedValue(field, config);
  return {
    path,
    value,
    isDefault: base !== undefined && sameValue(value, base),
    ...(readPath(project, path) !== undefined ? { fromProject: true as const } : {}),
    type: field.type,
    ...(field.options ? { options: field.options } : {}),
    access: field.access,
    live: isLiveField(path),
    env: envOverride(field) ?? null,
    why: field.why,
    ...(field.ms ? { ms: true } : {}),
    ...(field.requiredWhen ? { requiredWhen: field.requiredWhen } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
  };
}

export function describeRunningConfig(config: Config, project: Partial<Config> = {}): RunningConfigGroup[] {
  const baseline = baselineConfig(project);
  const claimed = new Set<string>();
  const groups: RunningConfigGroup[] = [];

  for (const group of GROUPS) {
    const entries: RunningConfigEntry[] = [];
    for (const key of group.keys) {
      claimed.add(key);
      for (const field of CONFIG_FIELDS) {
        if (field.path !== key && !field.path.startsWith(`${key}.`)) continue;
        const entry = entryFor(field.path, config, baseline, project);
        if (entry) entries.push(entry);
      }
    }
    if (entries.length > 0) groups.push({ title: group.title, entries });
  }

  const declared = new Set(CONFIG_FIELDS.map((field) => field.path.split('.')[0]));
  const others: RunningConfigEntry[] = [];
  for (const key of Object.keys(config) as (keyof Config)[]) {
    if (claimed.has(key) || declared.has(key)) continue;
    flatten(config[key], baseline[key], key, others, project);
  }
  if (others.length > 0) groups.push({ title: 'Other', entries: others });

  return groups;
}
