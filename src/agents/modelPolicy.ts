import { DISPATCH_PIPELINE } from '../dispatcher/rules.js';

/**
 * Which model each kind of work runs on, keyed on the dispatch rule that proposed it — the
 * same id `Task.rule` and `src/taskTypeSpend.ts` already use. →
 * `docs/spec/02-configuration.md#model-assignment-by-rule`
 */
export interface AgentModels {
  /**
   * Profile name to the model it runs and the depth it runs at. The profile is the only
   * place the pair is made, so the two never come from different profiles.
   */
  profiles: Record<string, AgentProfile>;
  /**
   * The profile every rule with no {@link byRule} entry runs on, **and** every dispatch
   * composed outside a rule.
   */
  default?: string;
  /** The per-kind assignments: dispatch rule id to profile name. */
  byRule?: Record<string, string>;
}

/** One named profile: what to launch, and how hard to think. */
interface AgentProfile {
  /** Where this profile sits on the cheap-to-deep ladder, low first. */
  rank: number;
  /** One sentence saying what this profile is *for*, written for an agent. */
  description: string;
  /**
   * Whatever string `claude --model` accepts — an alias or a full id; prefer a full id,
   * since an alias re-points itself when a new model ships. Never validated here: only the
   * installed CLI knows the set, so a bad value fails at spawn.
   */
  model: string;
  /** Passed to `claude --effort`. */
  effort?: AgentEffort;
}

/** The levels `claude --effort` takes, cheapest first. */
type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** What one dispatch launches on, once the lookup has run. */
interface ResolvedProfile {
  /** The profile's name, recorded on the task so a run says which one it was. */
  name: string;
  model: string;
  effort: string | null;
  /** Which level of {@link resolveAgentProfile}'s chain answered. */
  source: ProfileSource;
}

/** Which level of the precedence chain named the profile a run launched on. */
export type ProfileSource = 'pin' | 'rule' | 'default';

/** The rule ids that can actually appear on a dispatched action's `rule`. */
const STAGE_RULE_IDS: ReadonlySet<string> = new Set(DISPATCH_PIPELINE.map((r) => r.id));

/**
 * Refuse a model policy that cannot do what it says, at load, naming the key — every fault
 * here is otherwise invisible (an unresolvable profile launches with no flag, a typo'd rule
 * id never matches). → `docs/spec/02-configuration.md#model-assignment-by-rule`
 */
export function validateAgentModels(models: AgentModels | undefined): void {
  if (!models) return;
  const profiles = models.profiles;
  if (typeof profiles !== 'object' || profiles === null)
    throw new Error('Refusing to start: agentModels.profiles must be an object of profile name to model string.');
  for (const [name, profile] of Object.entries(profiles)) {
    if (typeof profile !== 'object' || profile === null)
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}" must be an object — {"model": "...", "effort": "..."}. ` +
          `A bare model string is no longer accepted; write {"model": ${JSON.stringify(profile)}} instead.`,
      );
    if (typeof profile.model !== 'string' || profile.model.length === 0)
      throw new Error(`Refusing to start: agentModels.profiles."${name}".model must be a non-empty model string.`);
    if (profile.effort !== undefined && !EFFORT_LEVELS.includes(profile.effort))
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}".effort is "${profile.effort}", which is not an effort ` +
          `level. Known levels: ${EFFORT_LEVELS.join(', ')}.`,
      );
    if (typeof profile.rank !== 'number' || !Number.isFinite(profile.rank))
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}".rank must be a number — where this profile sits on ` +
          `the cheap-to-deep ladder, low first. It is what lets the goal-profile gate say whether a proposal ` +
          `is cheaper or deeper than what is standing.`,
      );
    if (typeof profile.description !== 'string' || profile.description.trim().length === 0)
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}".description must be a non-empty sentence saying what ` +
          `this profile is for. It is the whole of what the appraiser is told about your profiles when it ` +
          `proposes one, so a missing or empty one makes every proposal a guess.`,
      );
  }
  // Ranks decide a direction, so two profiles cannot share one: equal ranks leave
  // "cheaper or deeper?" unanswerable and the cockpit ordering implicit.
  const byRank = new Map<number, string>();
  for (const [name, profile] of Object.entries(profiles)) {
    const clash = byRank.get(profile.rank);
    if (clash !== undefined)
      throw new Error(
        `Refusing to start: agentModels.profiles."${name}" and "${clash}" both have rank ${profile.rank}. ` +
          `Ranks order the profiles cheapest-first and must be unique.`,
      );
    byRank.set(profile.rank, name);
  }
  const known = (name: string): boolean => Object.hasOwn(profiles, name);
  if (models.default !== undefined && !known(models.default))
    throw new Error(
      `Refusing to start: agentModels.default names profile "${models.default}", which is not in agentModels.profiles.`,
    );
  for (const [rule, profile] of Object.entries(models.byRule ?? {})) {
    if (!STAGE_RULE_IDS.has(rule))
      throw new Error(
        `Refusing to start: agentModels.byRule."${rule}" is not a dispatch rule id — it would never match. ` +
          `Known ids: ${[...STAGE_RULE_IDS].join(', ')}.`,
      );
    if (!known(profile))
      throw new Error(
        `Refusing to start: agentModels.byRule."${rule}" names profile "${profile}", which is not in agentModels.profiles.`,
      );
  }
}

/**
 * What a run dispatched by this rule launches on, or null for "pass neither flag" — what a
 * deployment with no `agentModels` gets everywhere. Resolved as a whole profile, never
 * field by field, so a fallback cannot pair one profile's model with another's effort.
 */
export function resolveAgentProfile(
  models: AgentModels | undefined,
  rule: string | null | undefined,
  pinned?: string | null,
): ResolvedProfile | null {
  if (!models) return null;
  // The pin wins whether deeper or cheaper than the rule's entry. An unknown pin
  // falls through rather than resolving to nothing — a ticket tag is human-written
  // and cannot be refused at boot, so the rule's own entry still answers.
  const pin = pinned && Object.hasOwn(models.profiles, pinned) ? pinned : undefined;
  const source: ProfileSource = pin ? 'pin' : rule && models.byRule?.[rule] ? 'rule' : 'default';
  const name = pin ?? (rule ? models.byRule?.[rule] : undefined) ?? models.default;
  if (name === undefined) return null;
  const profile = models.profiles[name];
  if (profile === undefined) return null;
  return { name, model: profile.model, effort: profile.effort ?? null, source };
}

/**
 * The configured profile names, cheapest first — the one order every operator- and
 * agent-facing list uses, so they agree about which way "up" is.
 */
export function orderedProfiles(models: AgentModels | undefined): { name: string; description: string }[] {
  if (!models) return [];
  return Object.entries(models.profiles)
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([name, profile]) => ({ name, description: profile.description }));
}

/**
 * Where a profile sits on the ladder, or null when this deployment has no such profile —
 * null rather than a sentinel, which would read as a downgrade.
 */
export function profileRank(models: AgentModels | undefined, name: string | null | undefined): number | null {
  if (!models || !name) return null;
  const profile = models.profiles[name];
  return profile ? profile.rank : null;
}
