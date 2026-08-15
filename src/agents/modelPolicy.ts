import { DISPATCH_PIPELINE } from '../dispatcher/rules.js';

/**
 * Which model each kind of work runs on, keyed on the dispatch rule that proposed
 * it (issue #321).
 *
 * The key is a `DISPATCH_RULES` id because that is already what a task records
 * (`Task.rule`) and already the axis `src/taskTypeSpend.ts` prices work by — so
 * config, spend and the decision log share one vocabulary rather than growing a
 * second.
 *
 * The rule points at a **named profile**, and a profile is a model and how hard
 * to run it. The indirection buys a stable name (`fast`, `deep`) that survives a
 * model being replaced: when a new model ships, one profile value changes and
 * every rule pointing at it follows. It is also what makes the load-time
 * rejection below possible at all — a bare model string can only be validated by
 * the installed CLI.
 *
 * Deliberately carries nothing but those two: no permission mode, no extra args.
 * `claudeArgs` stays the single global escape hatch, which structurally removes
 * the risk of a profile's args clobbering the `--allowedTools` MCP grants. Both
 * fields here are flags the harness emits itself, which is what keeps them out of
 * that argument.
 */
export interface AgentModels {
  /**
   * Profile name to the model it runs and the depth it runs at. Both are for one
   * launch, and the profile is the only place they are paired: a rule assigned
   * `fast` gets that model *and* that effort, never one from one profile and one
   * from another.
   */
  profiles: Record<string, AgentProfile>;
  /**
   * The profile every rule with no {@link byRule} entry runs on, **and** every
   * dispatch composed outside a rule. An operator who sets only this has moved
   * the whole fleet with one line. Omitted, an unassigned rule carries no
   * `--model` at all.
   */
  default?: string;
  /** The per-kind assignments: dispatch rule id to profile name. */
  byRule?: Record<string, string>;
}

/** One named profile: what to launch, and how hard to think. */
interface AgentProfile {
  /**
   * Whatever string `claude --model` accepts — an alias (`haiku`, `sonnet`,
   * `opus`) or a full model id. The harness never validates the model itself;
   * only the installed CLI knows the valid set, so a profile holding a bad alias
   * fails at spawn rather than at boot.
   *
   * Prefer a full id. Both are accepted, but an alias re-points itself the day a
   * new model ships — which is the profile *name*'s job, and makes a stored
   * `Task.model` a worse record of what a run actually cost.
   */
  model: string;
  /**
   * Passed to `claude --effort`. Omitted leaves the flag off, and the CLI's own
   * default applies — which is not the same as a low setting: the CLI defaults to
   * the top of the ladder, so an unset effort is the *expensive* choice, not the
   * neutral one.
   *
   * Which levels a model accepts is the CLI's business, not the harness's — the
   * smaller models reject the flag outright. Like {@link model}, a level this
   * deployment's models cannot take fails at spawn.
   */
  effort?: AgentEffort;
}

/**
 * The levels `claude --effort` takes, cheapest first.
 *
 * Not exported: the config surface is the profile, and a second name for this in
 * `src/types.ts` is the vocabulary drift the rule-id-as-key choice above exists
 * to avoid. `Task.effort` stores the resolved string for the same reason
 * `Task.rule` is a plain string — a domain type does not reach in here.
 */
type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** What one dispatch launches on, once the rule has been looked up. */
interface ResolvedProfile {
  model: string;
  effort: string | null;
}

/** The rule ids that can actually appear on a dispatched action's `rule`. */
const STAGE_RULE_IDS: ReadonlySet<string> = new Set(DISPATCH_PIPELINE.map((r) => r.id));

/**
 * Refuse a model policy that cannot do what it says, at load, naming the key.
 *
 * Every rejection is here because the alternative is invisible rather than
 * because validation is virtuous: a profile name that resolves to nothing would
 * launch with no flag (or a garbage one) and read as working, and a typo'd rule
 * id would simply never match — the exact failure class the config rules exist to
 * prevent.
 *
 * The bare-string profile is refused by name for that reason too. It was the
 * shape before profiles carried an effort, and accepting both would leave one
 * config key with two spellings — the drift the named profile exists to end. A
 * deployment carrying the old shape stops at boot with the fix in the message,
 * rather than starting with a profile the resolver reads as having no model.
 *
 * Validated against the *pipeline* ids rather than the whole `DISPATCH_RULES`
 * registry: `admission` and `terminal` entries (`cooldown-escalate`, `idle`)
 * never reach `action.rule`, so accepting one as a key would make the typo check
 * weaker than it looks.
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
 * What a run dispatched by this rule launches on, or null for "pass neither flag"
 * — which is exactly today's behaviour, and what a deployment with no
 * `agentModels` block gets everywhere.
 *
 * Resolved as a **whole profile**, never field by field: the model and the effort
 * a rule runs at are one decision, and a lookup that fell back for one and not
 * the other could pair a cheap model with a depth chosen for an expensive one.
 *
 * Called once, at dispatch, where the task row is written. Resolving here rather
 * than at spawn is what makes a boot-resumed agent re-launch on what it started
 * on rather than whatever config now says, and it keeps `AgentManager` ignorant
 * of both rules and profiles — it forwards two strings.
 *
 * A pure function of the rule: a retry runs the same profile, so no dispatch
 * depends on run history.
 */
export function resolveAgentProfile(
  models: AgentModels | undefined,
  rule: string | null | undefined,
): ResolvedProfile | null {
  if (!models) return null;
  const name = (rule ? models.byRule?.[rule] : undefined) ?? models.default;
  if (name === undefined) return null;
  const profile = models.profiles[name];
  if (profile === undefined) return null;
  return { model: profile.model, effort: profile.effort ?? null };
}
