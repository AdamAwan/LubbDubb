import type { Config } from '../config.js';
import {
  POLICY_KINDS,
  policyCheckMode,
  type PolicyCheckMode,
  type PolicyKind,
} from '../integrations/azure/policyKinds.js';
import { ruleStates, type CiFailureAction, type CiWatchState } from './ciPolicy.js';

// → docs/spec/07-pull-requests.md#ci

export interface CiRuleDescription {
  match: string;
  states: CiWatchState[];
  statesInherited: boolean;
  onFailure: CiFailureAction;
  inherited: boolean;
  guidance: string | null;
  urgent: boolean;
}

export interface PolicyKindDescription {
  kind: PolicyKind;
  mode: PolicyCheckMode;
  isDefault: boolean;
}

export interface CiPolicyDescription {
  rules: CiRuleDescription[];
  unmatched: CiFailureAction;
  policyKinds: PolicyKindDescription[] | null;
}

export function describeCiPolicy(config: Config): CiPolicyDescription {
  const modes = config.azureDevOps?.policyChecks;
  return {
    rules: config.ci.checks.map((rule) => ({
      match: rule.match,
      states: [...ruleStates(rule)],
      statesInherited: rule.states === undefined,
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
