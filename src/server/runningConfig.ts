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
 * The resolved configuration, described for an operator reading it back — and,
 * since #401, editing it.
 *
 * The cockpit could be handed the `Config` object and left to render it, but the
 * question an operator actually asks is not "what are the values" — it is "what
 * did *I* change", and answering that needs the baseline. Doing the comparison
 * here rather than in the cockpit keeps the web bundle free of server code (it
 * imports none, deliberately) and keeps the one thing worth testing pure.
 *
 * The same argument now carries three more facts a form needs and a table did
 * not: what each value *is* (`configFields.ts`), whether saving it takes effect
 * now (`configApply.ts`, which knows because it holds the arm), and whether the
 * environment is already beating the file for it. All three are computed here for
 * the reason `isDefault` is — a second copy in the browser would be free to
 * drift, and a browser that knows what a default *is* re-creates it instead of
 * clearing the key.
 *
 * **No redaction, and that is not an oversight.** `Config` holds no secrets by
 * construction — the same rule that keeps `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and
 * `LUBBDUBB_TOKEN` in the environment and out of the file an operator pastes when
 * asking for help. `auth.tokenFile` is a *path*, and blanking it would hide a
 * useful value while implying the invariant above is not real. If a secret ever
 * does land in `Config`, the fix is to take it back out, not to filter it here.
 * A write path is a new reason that invariant has to hold, not a reason to weaken
 * it: the form offers a field for a credential nowhere.
 */
export interface RunningConfigEntry {
  /** Dotted path into the config object, e.g. `planning.maxConcurrentPartsPerIssue`. */
  path: string;
  /** The running value. Arrays and leaf objects are shipped whole. */
  value: unknown;
  /**
   * Whether the value is the one this operator would have without their own file
   * — false means *they* chose it.
   *
   * The baseline is the built-in default with the targeted project's shared
   * config folded in, not the default alone, and the two readings differ on every
   * key a team sets. This one is the answer to both questions a row is asked:
   * "did I choose this" and "what does clearing it leave", which are the same
   * question because the form writes the operator's file and nothing else.
   */
  isDefault: boolean;
  /**
   * Set when the baseline came from the project's shared config rather than the
   * built-in default — so a row can say where an inherited value came from, and a
   * reset can say what it would fall back to.
   *
   * Without it the two layers are indistinguishable on the glass: a value a
   * teammate committed reads as a built-in default, and the operator who clears
   * their own override to "get back to the default" gets the team's value with
   * nothing having said so.
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
   * The key that makes this one required, and the one value of it that does not
   * — shipped as the declaration rather than as a resolved `required: boolean`.
   *
   * The exception to "the server decides and this only draws", and a narrow one:
   * the answer depends on what is **staged**, which is the one thing this side
   * cannot see. A `required` computed here would be the answer for the config the
   * harness is *running*, so an operator who picks the pool provider and saves
   * gets a 400 from the next boot's own refusal with no field on the page to fix
   * it. The rule is still stated once, in `configFields.ts`; the browser only
   * evaluates it. → `docs/spec/02-configuration.md#a-key-another-key-requires`
   */
  requiredWhen?: ConfigFieldRequirement;
  /**
   * A value to *offer* for an unset key, joined from keys the config already
   * holds — `userId` and `pool.project` make `alice@acme-api` for `fleetId`.
   *
   * Absent unless every part resolves to a non-empty string: half a suggestion is
   * `alice@` typed into a field whose whole job is to be an address nobody else
   * writes to. Nothing writes it on the operator's behalf, which is what keeps
   * "never derived" true — it is a button beside an empty field.
   */
  suggestion?: string;
}

/** Named for the wire contract (`src/wire.ts`), which the settings modal reads it through. */
export interface RunningConfigGroup {
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
      'knowledgeBlockChars',
      'knowledgeScopeStaleDays',
      'knowledgeColdDays',
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
      // The pool is an integration in the sense that decides this list: it is a
      // capability with a provider behind it, selected in `integrations`. Its two
      // identity keys sit beside `userId` for the same reason — one names the person
      // the harness acts as, the other names the fleet it publishes as.
      'fleetId',
      'pool',
      'labelPrefix',
      'issuePriorityLabels',
      'issueStateColours',
      'issueBoardStates',
      'issueDefaultPriority',
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
      'environments',
      'environmentProbeIntervalMs',
      'environmentHealthIntervalMs',
      'watchIntervalMs',
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
  { title: 'Server', keys: ['port', 'host', 'auth'] },
];

/**
 * The top-level keys some group claims.
 *
 * Exported for the one assertion {@link GROUPS} cannot make about itself: a
 * declared key in no group is drawn **nowhere**. The group loop never reaches it,
 * and the "Other" fallback skips it precisely *because* it is declared — so it
 * validates, applies, and is invisible on the page it was declared for, with
 * nothing red. `test/configFields.test.ts` closes that.
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
 * Flatten an *undeclared* key into dotted-path leaves.
 *
 * Only the "Other" group reaches this: a key `configFields.ts` names is drawn
 * from its declaration, at the depth the declaration chose. What is left is a
 * key nothing declares — a typo in a hand-edited file, or a config key added
 * without a field — and it is shown, unentered, because invisible is how a typo
 * survives.
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
 * One declared field, read out of the running config. `null` for an unset
 * optional — **except** one another key can require, which is drawn empty.
 *
 * An unset optional is not a configured value, and a column of blanks buries the
 * rest, so `github.owner` on a deployment with no GitHub target is absent rather
 * than empty. A key with a `requiredWhen` is the one thing that rule cannot
 * survive: the key it depends on is editable on this very page, so the moment an
 * operator selects the pool provider the field they must fill in is the field
 * that is not there — and the only thing that tells them is a 400 from the save.
 * One empty row is the cheaper of the two.
 */
function entryFor(path: string, config: Config, baseline: Config, project: Partial<Config>): RunningConfigEntry | null {
  const field = configField(path);
  /* istanbul ignore next — callers iterate CONFIG_FIELDS, so the lookup always hits. */
  if (!field) return null;
  const held = readPath(config, path);
  if (held === undefined && !field.requiredWhen) return null;
  // Empty, and reported as inherited: the operator has not chosen it, so there is
  // nothing for a reset to put back and no `file` chip to draw. `undefined` is the
  // only reading that means unset — `??` here would swallow `spendBurn.ceilingUsd`'s
  // null, which is a configured value meaning "no ceiling".
  const value = held === undefined ? '' : held;
  const base = held === undefined ? value : readPath(baseline, path);
  const suggestion = suggestedValue(field, config);
  return {
    path,
    value,
    // A path with no baseline (`github.owner`) has no default to be, so it is
    // reported as chosen — which it was.
    isDefault: base !== undefined && sameValue(value, base),
    // Presence in the layer, not a comparison against the built-in default: a
    // team that sets a key to the value it already had still set it, and a row
    // that said otherwise would send the operator to the wrong file to change it.
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
 * Describe a running config: every configured value, grouped, with the ones an
 * operator chose distinguished from the ones they inherited — and, of those,
 * the ones inherited from the team rather than from the build.
 *
 * `project` is the layer the targeted project's shared config contributed, not a
 * config: the question a row answers is "did this key come from there", and a
 * resolved config cannot say, since a team value equal to the default is
 * indistinguishable from no value at all once it is merged.
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
