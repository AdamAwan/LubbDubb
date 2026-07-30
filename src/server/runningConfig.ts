import { defaultConfig, type Config } from '../config.js';

/**
 * The resolved configuration, described for an operator reading it back.
 *
 * The cockpit could be handed the `Config` object and left to render it, but the
 * question an operator actually asks is not "what are the values" — it is "what
 * did *I* change", and answering that needs the baseline. Doing the comparison
 * here rather than in the cockpit keeps the web bundle free of server code (it
 * imports none, deliberately) and keeps the one thing worth testing pure.
 *
 * **No redaction, and that is not an oversight.** `Config` holds no secrets by
 * construction — the same rule that keeps `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and
 * `LUBBDUBB_TOKEN` in the environment and out of the file an operator pastes when
 * asking for help. `auth.tokenFile` is a *path*, and blanking it would hide a
 * useful value while implying the invariant above is not real. If a secret ever
 * does land in `Config`, the fix is to take it back out, not to filter it here.
 */
export interface RunningConfigEntry {
  /** Dotted path into the config object, e.g. `planning.requireApproval`. */
  path: string;
  /** The running value. Arrays and leaf objects are shipped whole. */
  value: unknown;
  /** Whether this is the built-in default — false means somebody chose it. */
  isDefault: boolean;
}

/** Named but unexported: it is reachable as `describeRunningConfig`'s return type. */
interface RunningConfigGroup {
  title: string;
  entries: RunningConfigEntry[];
}

/**
 * Which group each top-level key is drawn under, in display order.
 *
 * A display hint and nothing more: a key naming no group here falls into
 * "Other" rather than vanishing, so a config field added later is visible on the
 * day it is written instead of being silently absent until somebody notices.
 * Same rule as a CI check matching no policy rule.
 */
const GROUPS: readonly { title: string; keys: readonly (keyof Config)[] }[] = [
  {
    title: 'Dispatch',
    keys: [
      'dispatcher',
      'heartbeatIntervalMs',
      'maxConcurrentAgents',
      'startPaused',
      'steeringPriorities',
      'closedPrWindowMs',
      'upNextOverrideTtlMs',
    ],
  },
  {
    title: 'Agents',
    keys: [
      'agentMode',
      'agentPermissionMode',
      'agentAllowedTools',
      'agentPromptDelayMs',
      'agentSubmitDelayMs',
      'agentIdleWaitMs',
      'agentWaitingPatterns',
      'whitelistedApprovals',
      'claudeCommand',
      'claudeArgs',
      'sessionTranscriptRoot',
    ],
  },
  {
    title: 'Integrations',
    keys: [
      'integrations',
      'github',
      'azureDevOps',
      'labelPrefix',
      'issuePickupRequireOwnLabel',
      'issuePriorityLabels',
      'issueDefaultPriority',
      'issuePickupStates',
      'issueInReviewState',
    ],
  },
  { title: 'Features', keys: ['planning', 'assessment', 'assay', 'mcp', 'autoSend', 'ci'] },
  {
    title: 'Paths',
    keys: ['repoRoot', 'defaultBranch', 'worktreeRoot', 'deskRoot', 'promptTemplatesDir', 'docsFolderPrefix', 'dbPath'],
  },
  { title: 'Server', keys: ['port', 'host', 'auth'] },
];

/** A value worth recursing into: a plain object, so arrays and null stay leaves. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten `value` into dotted-path leaves, comparing each against `baseline`.
 *
 * Keys whose value is `undefined` are skipped entirely: an unset optional (no
 * `github` block, no `issuePickupStates`) is not a configured value, and listing
 * a column of blanks would bury the settings that are.
 */
function flatten(value: unknown, baseline: unknown, prefix: string, out: RunningConfigEntry[]): void {
  if (value === undefined) return;
  if (isPlainObject(value)) {
    // A nested config object is expanded so a single overridden field inside it
    // (`planning.requireApproval`) is marked on its own, rather than the whole
    // block reading as customised because one member of it is.
    const base = isPlainObject(baseline) ? baseline : undefined;
    for (const key of Object.keys(value)) {
      flatten(value[key], base?.[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.push({
    path: prefix,
    value,
    // A path with no baseline (`github.owner`) has no default to be, so it is
    // reported as chosen — which it was.
    isDefault: baseline !== undefined && JSON.stringify(value) === JSON.stringify(baseline),
  });
}

/**
 * Describe a running config: every configured value, grouped, with the ones an
 * operator chose distinguished from the ones they inherited.
 */
export function describeRunningConfig(config: Config): RunningConfigGroup[] {
  const baseline = defaultConfig();
  const claimed = new Set<string>();
  const groups: RunningConfigGroup[] = [];

  for (const group of GROUPS) {
    const entries: RunningConfigEntry[] = [];
    for (const key of group.keys) {
      claimed.add(key);
      flatten(config[key], baseline[key], key, entries);
    }
    if (entries.length > 0) groups.push({ title: group.title, entries });
  }

  const others: RunningConfigEntry[] = [];
  for (const key of Object.keys(config) as (keyof Config)[]) {
    if (claimed.has(key)) continue;
    flatten(config[key], baseline[key], key, others);
  }
  if (others.length > 0) groups.push({ title: 'Other', entries: others });

  return groups;
}
