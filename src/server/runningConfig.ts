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

/**
 * The resolved configuration, described for an operator to read back and edit.
 * The baseline comparison and the form facts (`configFields.ts`, `configApply.ts`,
 * env overrides) are resolved here rather than in the cockpit, which imports no
 * server code and would be free to drift.
 *
 * **No redaction, and that is not an oversight.** `Config` holds no secrets by
 * construction — secrets live in the environment. If one ever lands in `Config`,
 * take it back out rather than filtering it here.
 */
export interface RunningConfigEntry {
  /** Dotted path into the config object, e.g. `planning.maxConcurrentPartsPerIssue`. */
  path: string;
  /** The running value. Arrays and leaf objects are shipped whole. */
  value: unknown;
  /**
   * Whether the value is the one this operator would have without their own file —
   * false means *they* chose it. The baseline is the built-in default with the
   * project's shared config folded in, not the default alone.
   */
  isDefault: boolean;
  /**
   * Set when the baseline came from the project's shared config rather than the
   * built-in default. Without it a teammate's committed value reads as a built-in
   * default, and a reset lands somewhere the operator was not told about.
   */
  fromProject?: true;
  /** What the value is, so the form can draw a control rather than a text box. */
  type: ConfigFieldType;
  /** The members, for an `enum`. */
  options?: readonly string[];
  /** How far an operator reaches to edit it. `fileOnly` is not offered at all. */
  access: ConfigFieldAccess;
  /** Whether saving it takes effect now, because an arm in `configApply.ts` re-seats it. */
  live: boolean;
  /** The environment variable currently beating the file, or null. Set means not editable. */
  env: string | null;
  /** One line under the key: why the field exists. */
  why: string;
  /** A duration in milliseconds, so the cockpit can say "5m" beside the number. */
  ms?: boolean;
  /**
   * The key that makes this one required, and the one value of it that does not —
   * shipped as the declaration, never as a resolved `required: boolean`, because
   * the answer depends on what is **staged**, which the server cannot see. The rule
   * is stated once in `configFields.ts`; the browser only evaluates it.
   * → `docs/spec/02-configuration.md#a-key-another-key-requires`
   */
  requiredWhen?: ConfigFieldRequirement;
  /**
   * A value to *offer* for an unset key, joined from keys the config already holds.
   * Absent unless every part resolves to a non-empty string, and never written on
   * the operator's behalf — it is a button beside an empty field.
   */
  suggestion?: string;
}

/** Named for the wire contract (`src/wire.ts`), which the settings modal reads it through. */
export interface RunningConfigGroup {
  title: string;
  entries: RunningConfigEntry[];
}

/**
 * Which group each top-level key is drawn under, in display order. A display hint
 * only: a key naming no group here falls into "Other" rather than vanishing.
 */
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
      // The pool is an integration: a capability with a provider behind it, selected
      // in `integrations`. Its identity keys sit beside `userId`.
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

/**
 * The top-level keys some group claims. Exported for the assertion {@link GROUPS}
 * cannot make about itself: a *declared* key in no group is drawn **nowhere** — the
 * "Other" fallback skips it because it is declared — and nothing goes red.
 * `test/configFields.test.ts` closes that.
 */
export function groupedTopLevelKeys(): ReadonlySet<string> {
  return new Set(GROUPS.flatMap((group) => group.keys as readonly string[]));
}

/** A value worth recursing into: a plain object, so arrays and null stay leaves. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Flatten an *undeclared* key into dotted-path leaves — only the "Other" group
 * reaches this. Such keys are shown, unentered, because invisible is how a typo in
 * a hand-edited file survives.
 */
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

/**
 * One declared field, read out of the running config. `null` for an unset optional
 * — **except** one another key can require, which is drawn empty so the field an
 * operator must fill in exists on the page before the save 400s.
 */
function entryFor(path: string, config: Config, baseline: Config, project: Partial<Config>): RunningConfigEntry | null {
  const field = configField(path);
  /* istanbul ignore next — callers iterate CONFIG_FIELDS, so the lookup always hits. */
  if (!field) return null;
  const held = readPath(config, path);
  if (held === undefined && !field.requiredWhen) return null;
  // Empty, and reported as inherited. `undefined` is the only reading that means
  // unset — `??` would swallow `spendBurn.ceilingUsd`'s null, a configured "no ceiling".
  const value = held === undefined ? '' : held;
  const base = held === undefined ? value : readPath(baseline, path);
  const suggestion = suggestedValue(field, config);
  return {
    path,
    value,
    // A path with no baseline (`github.owner`) has no default to be, so it is
    // reported as chosen — which it was.
    isDefault: base !== undefined && sameValue(value, base),
    // Presence in the layer, not a comparison against the built-in default: a team
    // that sets a key to the value it already had still set it.
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

/**
 * Describe a running config: every configured value, grouped, with chosen values
 * distinguished from inherited ones and, of those, the team's from the build's.
 * `project` is the shared-config *layer*, not a resolved config — merged, a team
 * value equal to the default is indistinguishable from no value at all.
 */
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
