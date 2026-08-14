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
 * The rule points at a **named profile**, and a profile is a model string and
 * nothing else. The indirection buys a stable name (`fast`, `deep`) that survives
 * a model being replaced: when a new model ships, one profile value changes and
 * every rule pointing at it follows. It is also what makes the load-time
 * rejection below possible at all — a bare model string can only be validated by
 * the installed CLI.
 *
 * Deliberately carries nothing but a model: no permission mode, no extra args.
 * `claudeArgs` stays the single global escape hatch, which structurally removes
 * the risk of a profile's args clobbering the `--allowedTools` MCP grants.
 */
export interface AgentModels {
  /**
   * Profile name to whatever string `claude --model` accepts — an alias
   * (`haiku`, `sonnet`, `opus`) or a full model id. The harness never validates
   * the model itself; only the installed CLI knows the valid set, so a profile
   * holding a bad alias fails at spawn rather than at boot.
   */
  profiles: Record<string, string>;
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

/** The rule ids that can actually appear on a dispatched action's `rule`. */
const STAGE_RULE_IDS: ReadonlySet<string> = new Set(DISPATCH_PIPELINE.map((r) => r.id));

/**
 * Refuse a model policy that cannot do what it says, at load, naming the key.
 *
 * Two rejections, both because the alternative is invisible rather than because
 * validation is virtuous: a profile name that resolves to nothing would launch
 * with no flag (or a garbage one) and read as working, and a typo'd rule id would
 * simply never match — the exact failure class the config rules exist to prevent.
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
  for (const [name, model] of Object.entries(profiles)) {
    if (typeof model !== 'string' || model.length === 0)
      throw new Error(`Refusing to start: agentModels.profiles."${name}" must be a non-empty model string.`);
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
 * The model a run dispatched by this rule launches on, or null for "pass no
 * `--model` at all" — which is exactly today's behaviour, and what a deployment
 * with no `agentModels` block gets everywhere.
 *
 * Called once, at dispatch, where the task row is written. Resolving here rather
 * than at spawn is what makes a boot-resumed agent re-launch on the model it
 * started on rather than whatever config now says, and it keeps `AgentManager`
 * ignorant of both rules and profiles — it forwards a string.
 *
 * A pure function of the rule: a retry runs the same profile, so no dispatch's
 * model depends on run history.
 */
export function resolveAgentModel(models: AgentModels | undefined, rule: string | null | undefined): string | null {
  if (!models) return null;
  const profile = (rule ? models.byRule?.[rule] : undefined) ?? models.default;
  if (profile === undefined) return null;
  return models.profiles[profile] ?? null;
}
