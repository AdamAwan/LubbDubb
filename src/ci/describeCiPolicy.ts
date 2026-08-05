import type { Config } from '../config.js';
import {
  POLICY_KINDS,
  policyCheckMode,
  type PolicyCheckMode,
  type PolicyKind,
} from '../integrations/azure/policyKinds.js';
import type { CiFailureAction } from './ciPolicy.js';

/**
 * The effective CI policy, described for an operator reading it back — the
 * mirror of `describeRunningConfig`, and here for the same reason.
 *
 * `/api/config` already ships `ci.checks`, but as a raw JSON leaf: it shows the
 * array, not what the array *means*. Two of the three things worth knowing are
 * not in the array at all. A rule with no `onFailure` **ignores** the check, and
 * a check matching **no rule** **dispatches** — both load-bearing, both decided
 * in {@link classifyCiFailures}, and neither visible by reading the file.
 *
 * Derived **here rather than in the browser** for the reason `runningConfig.ts`
 * states: the web bundle imports no server code, so a cockpit-side derivation
 * would be a second copy of these defaults, free to drift from the rule that
 * consults them with nothing to catch it. This reads the same
 * `rule.onFailure ?? 'ignore'` and the same {@link policyCheckMode} the harness
 * acts on, so the tab and the dispatcher cannot disagree.
 */

/** One `ci.checks` rule, with the action it *effectively* takes. */
export interface CiRuleDescription {
  /** The glob, verbatim — `*` any run of characters, `?` one, matched case-insensitively. */
  match: string;
  /** What a matching failure does. `rule.onFailure ?? 'ignore'`, never the raw field. */
  onFailure: CiFailureAction;
  /** True when `onFailure` was omitted and the `ignore` above is the inherited default. */
  inherited: boolean;
  /** Text appended to the agent's prompt. Only ever set with `onFailure: 'dispatch'`. */
  guidance: string | null;
  /** Whether a dispatch from this rule jumps the queue. */
  urgent: boolean;
}

/** One Azure branch-policy kind and the mode it is surfaced under. */
export interface PolicyKindDescription {
  kind: PolicyKind;
  /** The effective mode, read through `policyCheckMode` rather than re-derived. */
  mode: PolicyCheckMode;
  /** True when nothing in `azureDevOps.policyChecks` names this kind. */
  isDefault: boolean;
}

export interface CiPolicyDescription {
  /** The rules in policy order — first match wins per failing check. */
  rules: CiRuleDescription[];
  /**
   * What happens to a failing check no rule claims. A constant of
   * {@link classifyCiFailures} rather than config, stated in the payload so the
   * cockpit reports it rather than asserting it independently.
   */
  unmatched: CiFailureAction;
  /**
   * Which branch-policy kinds reach `ci.checks` as checks at all. **Null when
   * Azure is not the source-control provider** — under GitHub these modes are
   * consulted by nothing, and a table of defaults nothing reads is a worse
   * answer than no table.
   */
  policyKinds: PolicyKindDescription[] | null;
}

/** Describe the CI policy this process is running on. Pure over `config`. */
export function describeCiPolicy(config: Config): CiPolicyDescription {
  const modes = config.azureDevOps?.policyChecks;
  return {
    rules: config.ci.checks.map((rule) => ({
      match: rule.match,
      onFailure: rule.onFailure ?? 'ignore',
      inherited: rule.onFailure === undefined,
      guidance: rule.guidance ?? null,
      urgent: rule.urgent === true,
    })),
    unmatched: 'dispatch',
    policyKinds:
      config.integrations.sourceControl === 'azure'
        ? POLICY_KINDS.map((kind) => ({
            kind,
            mode: policyCheckMode(kind, modes),
            isDefault: modes?.[kind] === undefined,
          }))
        : null,
  };
}
