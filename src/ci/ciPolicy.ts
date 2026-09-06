import type { CiCheck } from '../types.js';

// → docs/spec/07-pull-requests.md#ci

export type CiFailureAction = 'dispatch' | 'ignore' | 'escalate';

const CI_FAILURE_ACTIONS: readonly CiFailureAction[] = ['dispatch', 'ignore', 'escalate'];

const CI_WATCH_STATES = ['failing', 'pending'] as const;

export type CiWatchState = (typeof CI_WATCH_STATES)[number];

const DEFAULT_WATCH_STATES: readonly CiWatchState[] = ['failing'];

interface CiCheckRule {
  match: string;
  states?: CiWatchState[];
  onFailure?: CiFailureAction;
  guidance?: string;
  urgent?: boolean;
}

export interface CiPolicy {
  checks: CiCheckRule[];
}

interface CiMatch {
  name: string;
  rule: CiCheckRule | null;
  blocking?: boolean;
  expired?: boolean;
  requeueRef?: string;
}

export interface CiVerdict {
  actionable: boolean;
  dispatch: CiMatch[];
  escalate: CiMatch[];
  ignored: CiMatch[];
  urgent: boolean;
}

export function validateCiPolicy(policy: CiPolicy): void {
  policy.checks.forEach((rule, i) => {
    const where = `ci.checks[${i}]`;
    if (typeof rule.match !== 'string' || rule.match.trim() === '') {
      throw new Error(`${where}: "match" must be a non-empty glob matching a CI check name.`);
    }
    if (rule.states !== undefined) {
      if (!Array.isArray(rule.states) || rule.states.length === 0) {
        throw new Error(
          `${where} ("${rule.match}"): "states" must name at least one check state (${CI_WATCH_STATES.join(' | ')}). ` +
            'An empty list claims nothing, so the rule could never fire — omit it to take the default ["failing"].',
        );
      }
      for (const state of rule.states) {
        if ((CI_WATCH_STATES as readonly string[]).includes(state)) continue;
        const why =
          String(state) === 'passing'
            ? ' A passing check asks nothing of anyone, so a rule watching one could never fire.'
            : '';
        throw new Error(
          `${where} ("${rule.match}"): state "${String(state)}" is not one of ${CI_WATCH_STATES.join(' | ')}.${why}`,
        );
      }
    }
    if (rule.onFailure !== undefined && !CI_FAILURE_ACTIONS.includes(rule.onFailure)) {
      throw new Error(
        `${where} ("${rule.match}"): onFailure "${rule.onFailure}" is not one of ${CI_FAILURE_ACTIONS.join(' | ')}.`,
      );
    }
    if (rule.guidance !== undefined && (rule.onFailure ?? 'ignore') !== 'dispatch') {
      throw new Error(
        `${where} ("${rule.match}"): "guidance" is written for an agent, but onFailure is ` +
          `"${rule.onFailure ?? 'ignore'}" (the default), so no agent is dispatched and the guidance would be ` +
          `discarded. Set onFailure to "dispatch", or drop the guidance.`,
      );
    }
    if (rule.urgent && (rule.onFailure ?? 'ignore') !== 'dispatch') {
      throw new Error(
        `${where} ("${rule.match}"): "urgent" orders the dispatch queue, but onFailure is ` +
          `"${rule.onFailure ?? 'ignore'}" (the default), so nothing is queued.`,
      );
    }
    if (!ruleStates(rule).includes('failing') && (rule.onFailure ?? 'ignore') === 'escalate') {
      throw new Error(
        `${where} ("${rule.match}"): "states" is [${ruleStates(rule).join(', ')}], which never includes a failing ` +
          'check, but onFailure is "escalate". The harness has no escalation arm for a check that is merely ' +
          'waiting — rule `pr-ci-blocked` asks a human about a red pull request whose failures are all held — so ' +
          'this rule could never fire. Use "dispatch" to send an agent for the waiting check, "ignore" to mute it, ' +
          'or add "failing" to "states".',
      );
    }
  });
}

export function ruleStates(rule: CiCheckRule): readonly CiWatchState[] {
  return rule.states ?? DEFAULT_WATCH_STATES;
}

function ruleClaims(rule: CiCheckRule, check: CiCheck): boolean {
  if (!(ruleStates(rule) as readonly string[]).includes(check.status)) return false;
  return [check.name, ...(check.aliases ?? [])].some((name) => matchesCheckGlob(rule.match, name));
}

export function classifyCiFailures(checks: CiCheck[] | undefined, policy: CiPolicy, detailWithheld = false): CiVerdict {
  const reported = checks ?? [];
  const failing = reported.filter((c) => c.status === 'failing' && !c.advisory);
  if (failing.length === 0) {
    return {
      actionable: reported.length === 0 && !detailWithheld,
      dispatch: [],
      escalate: [],
      ignored: [],
      urgent: false,
    };
  }

  const dispatch: CiMatch[] = [];
  const escalate: CiMatch[] = [];
  const ignored: CiMatch[] = [];
  let urgent = false;

  for (const check of failing) {
    const rule = policy.checks.find((r) => ruleClaims(r, check)) ?? null;
    const match: CiMatch = { name: check.name, rule, blocking: check.blocking };
    const action: CiFailureAction = rule ? (rule.onFailure ?? 'ignore') : 'dispatch';
    if (action === 'dispatch') {
      dispatch.push(match);
      if (rule?.urgent) urgent = true;
    } else if (action === 'escalate') {
      escalate.push(match);
    } else {
      ignored.push(match);
    }
  }

  return { actionable: dispatch.length > 0, dispatch, escalate, ignored, urgent };
}

export interface CiWatchVerdict {
  watched: CiMatch[];
  urgent: boolean;
}

export function classifyWatchedChecks(checks: CiCheck[] | undefined, policy: CiPolicy): CiWatchVerdict {
  const watched: CiMatch[] = [];
  let urgent = false;

  for (const check of checks ?? []) {
    if (check.status === 'failing' || check.advisory) continue;
    const rule = policy.checks.find((r) => ruleClaims(r, check));
    if (rule && (rule.onFailure ?? 'ignore') !== 'dispatch') continue;
    if (!rule && !check.expired) continue;
    const match: CiMatch = { name: check.name, rule: rule ?? null, blocking: check.blocking };
    if (check.expired) match.expired = true;
    if (check.requeueRef) match.requeueRef = check.requeueRef;
    watched.push(match);
    if (rule?.urgent) urgent = true;
  }

  return { watched, urgent };
}

export function ciWatchNote(verdict: CiWatchVerdict): string {
  if (verdict.watched.length === 0) return '';
  const lines = ['The checks that are waiting:'];
  for (const m of verdict.watched) {
    const guidance = m.rule?.guidance?.trim();
    lines.push(`- ${m.name}${guidance ? `: ${guidance}` : ''}`);
  }

  const expired = verdict.watched.filter((m) => m.expired).map((m) => m.name);
  if (expired.length > 0) {
    lines.push(
      `These are expired, not running — ${expired.join(', ')}. Their last run was against older commits on this ` +
        'branch, so nothing is in flight and nothing will start on its own: a new run has to be queued against the ' +
        'current head. Queue it the way this project queues one — the branch policy names the build definition. ' +
        'Do not change code, tests or pipeline configuration to provoke a run, and if you cannot queue one, ' +
        'escalate saying so.',
    );
  }

  const optional = verdict.watched.filter((m) => m.blocking === false).map((m) => m.name);
  if (optional.length > 0) {
    lines.push(
      `These do not block the merge — ${optional.join(', ')}. Do the work anyway; they are named here so you do ` +
        'not read the pull request being mergeable as the gate having cleared.',
    );
  }

  return `\n\n${lines.join('\n')}`;
}

export function ciNeedsHuman(verdict: CiVerdict): boolean {
  return !verdict.actionable && verdict.escalate.length > 0;
}

export function ciFailureNote(verdict: CiVerdict): string {
  const lines: string[] = [];

  const guided = verdict.dispatch.filter((m) => m.rule?.guidance);
  if (guided.length > 0) {
    lines.push('Guidance for the specific checks that are failing:');
    for (const m of guided) lines.push(`- ${m.name}: ${m.rule!.guidance!.trim()}`);
  }

  const optional = verdict.dispatch.filter((m) => m.blocking === false).map((m) => m.name);
  if (optional.length > 0) {
    lines.push(
      `These failing checks do not block the merge — ${optional.join(', ')}. Fix them anyway; they are ` +
        'named here so you do not read the pull request being mergeable as your fix having landed.',
    );
  }

  const held = [...verdict.ignored, ...verdict.escalate].map((m) => m.name);
  if (held.length > 0) {
    lines.push(
      `These checks are also failing but are NOT yours to fix — ${held.join(', ')}. ` +
        'They are known to be owned elsewhere. Do not modify code, config or workflows to chase them, ' +
        'and do not treat CI still being red because of them as your fix having failed.',
    );
  }

  return lines.length > 0 ? `\n\n${lines.join('\n')}` : '';
}

export function matchesCheckGlob(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : `\\${ch}`));
  return new RegExp(`^${escaped}$`, 'i').test(name);
}
