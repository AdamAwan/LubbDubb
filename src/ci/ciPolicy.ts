import type { CiCheck } from '../types.js';

/**
 * Per-check CI policy: what the harness does about which check went red, where the aggregate
 * `ciStatus` allowed only one response to every failure. Pure over `(checks, policy)`, and
 * `prHealth` renders the same verdict, so the cockpit and the rule cannot disagree. A rule can
 * also watch a check that is not failing — a separate walk, {@link classifyWatchedChecks}.
 */

/** What a failing check makes the harness do. */
export type CiFailureAction = 'dispatch' | 'ignore' | 'escalate';

/** Every legal `onFailure` value, so config validation and the type can't drift. */
const CI_FAILURE_ACTIONS: readonly CiFailureAction[] = ['dispatch', 'ignore', 'escalate'];

/** The check states a rule may watch. `passing` is deliberately not one: a rule naming it could never fire, and {@link validateCiPolicy} refuses it. */
const CI_WATCH_STATES = ['failing', 'pending'] as const;

export type CiWatchState = (typeof CI_WATCH_STATES)[number];

/** What a rule watches when it names no states — today's behaviour, exactly. */
const DEFAULT_WATCH_STATES: readonly CiWatchState[] = ['failing'];

/** One operator-configured rule, matched against a check's name and its state. */
interface CiCheckRule {
  /** Glob against the check name (`*`/`?`), matched case-insensitively against every alias the provider reports too — see {@link CiCheck.aliases}. */
  match: string;
  /**
   * Which check states this rule claims; defaults to `['failing']`. Scopes the whole rule
   * rather than adding to the failing case — matched on the `(glob, state)` pair — so one
   * check can have two rules, one per state. A `pending`-only rule with `onFailure: 'ignore'`
   * mutes the expiry default while leaving genuine failures dispatching.
   */
  states?: CiWatchState[];
  /** What to do when a check this rule claims is in one of its {@link states}. Defaults to `ignore`. Named `onFailure` for config compatibility only. */
  onFailure?: CiFailureAction;
  /** Appended to the agent's prompt when this check fired. Only meaningful with `onFailure: 'dispatch'`; `loadConfig` refuses the other combination. */
  guidance?: string;
  /** Sort this PR's concern ahead of every other PR concern this cycle. A boolean, never a rank — `priority_overrides` is the harness's one numeric axis. */
  urgent?: boolean;
}

export interface CiPolicy {
  /** Ordered — first match wins per check, like {@link DISPATCH_RULES}. */
  checks: CiCheckRule[];
}

/** A failing check paired with the rule that claimed it (null = matched nothing). */
interface CiMatch {
  name: string;
  rule: CiCheckRule | null;
  /** False when the provider says this failure does not hold the merge. */
  blocking?: boolean;
  /** The check is waiting on a run nobody has started ({@link CiCheck.expired}). Only set in {@link CiWatchVerdict}, the one entry there that may carry a null {@link rule}. */
  expired?: boolean;
  /** The provider's own handle for queueing a fresh run ({@link CiCheck.requeueRef}), so rule `pr-ci-gate` can settle the gate with one write instead of an agent. Absent where the harness cannot requeue, falling back to dispatch. */
  requeueRef?: string;
}

export interface CiVerdict {
  /** Dispatch an agent for this PR's CI. True when something actionable is failing, or when the provider reported no per-check detail at all (keeps a project with no `ci` config, and the `fake` provider, behaving as before). */
  actionable: boolean;
  /** Failing checks an agent should fix. Empty when detail is absent. */
  dispatch: CiMatch[];
  /** Failing checks whose rule asks for a human instead. */
  escalate: CiMatch[];
  /** Failing checks the operator has told the harness to leave alone. */
  ignored: CiMatch[];
  /** Any dispatched check's rule asked to jump the queue. */
  urgent: boolean;
}

/** Reject a policy that cannot mean what it says, at load rather than at 3am — most of all `guidance` on a rule that isn't dispatching, where the words would vanish silently. */
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
        // `passing` is a real check state; name why it is refused.
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
    // A pending-only `ignore` rule is legal: it shadows the expiry default while leaving the
    // agent fix for a genuine failure. `escalate` is refused — no escalation arm exists for a
    // check that is merely waiting.
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

/** The states a rule claims, with the default applied. Never read `rule.states` raw. */
export function ruleStates(rule: CiCheckRule): readonly CiWatchState[] {
  return rule.states ?? DEFAULT_WATCH_STATES;
}

/** Does this rule claim this check? The `(glob, state)` pair, in one place, so the failing and watched walks cannot answer it differently. Tried against every alias too. */
function ruleClaims(rule: CiCheckRule, check: CiCheck): boolean {
  if (!(ruleStates(rule) as readonly string[]).includes(check.status)) return false;
  return [check.name, ...(check.aliases ?? [])].some((name) => matchesCheckGlob(rule.match, name));
}

/**
 * Classify a failing PR's checks against the policy. Call only when the PR's aggregate
 * `ciStatus` is `failing` — this does not re-derive whether it is red. No checks reported is
 * missing detail (actionable, empty lists); a check matching no rule is actionable and named,
 * so a CI job added next week is fixed rather than parking the PR forever; an advisory check is
 * dropped before anything is decided. `detailWithheld` says the detail exists and was withheld
 * — the operator's instruction not to act — distinct from a provider that simply reports none.
 */
export function classifyCiFailures(checks: CiCheck[] | undefined, policy: CiPolicy, detailWithheld = false): CiVerdict {
  const reported = checks ?? [];
  // Advisory checks are dropped up front, so no rule — not even `match: '*'` — can claim one.
  const failing = reported.filter((c) => c.status === 'failing' && !c.advisory);
  if (failing.length === 0) {
    // No checks reported at all stays actionable, so a red PR without detail still gets an agent.
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
    // No rule claimed it => the pre-config behaviour for that check: fix it.
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

/** The checks a rule is watching in a state that is not `failing`. */
export interface CiWatchVerdict {
  /** Watched checks an agent should be sent for: either a rule that dispatches, or an expired check no rule claimed, watched on the provider's word. */
  watched: CiMatch[];
  /** Any watched check's rule asked to jump the queue. */
  urgent: boolean;
}

/**
 * Classify the checks that are not failing — the gate sitting `pending` until something outside
 * the harness acts on it. Deliberately a second function, never a widening of
 * {@link classifyCiFailures}: that verdict answers what is wrong with the build, and a waiting
 * check folded into it would answer "CI failing" to a question about a merge. Advisory checks
 * are dropped first, in any state. An expired check ({@link CiCheck.expired}) is watched with no
 * rule naming it by default — expiry is the provider stating no run is in flight, where a
 * `states: ['pending']` rule would instead fire on every mid-flight build.
 */
export function classifyWatchedChecks(checks: CiCheck[] | undefined, policy: CiPolicy): CiWatchVerdict {
  const watched: CiMatch[] = [];
  let urgent = false;

  for (const check of checks ?? []) {
    if (check.status === 'failing' || check.advisory) continue;
    const rule = policy.checks.find((r) => ruleClaims(r, check));
    // First-match-wins: a non-dispatch rule exempts a check from a broad watch glob too.
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

/** The per-check briefing appended to the agent's waiting-gate prompt. Appended, never interpolated — see {@link ciFailureNote}. */
export function ciWatchNote(verdict: CiWatchVerdict): string {
  if (verdict.watched.length === 0) return '';
  const lines = ['The checks that are waiting:'];
  for (const m of verdict.watched) {
    const guidance = m.rule?.guidance?.trim();
    lines.push(`- ${m.name}${guidance ? `: ${guidance}` : ''}`);
  }

  // Name the cause, or the agent has a check name and no idea what releases it.
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

/** Whether to put this red PR to a human instead of an agent. Only when nothing is dispatchable — otherwise an agent already works the branch, and held checks reach it via {@link ciFailureNote}. */
export function ciNeedsHuman(verdict: CiVerdict): boolean {
  return !verdict.actionable && verdict.escalate.length > 0;
}

/**
 * The per-check briefing appended to the agent's CI-fix prompt. Appended, never filled into a
 * `{placeholder}`: `pr-ci-fix` is operator-overridable, and an override that never learned the
 * token would drop the guidance silently. Held checks are named rather than hidden, or an agent
 * watches CI stay red after a correct fix and chases a failure that was never its own.
 */
export function ciFailureNote(verdict: CiVerdict): string {
  const lines: string[] = [];

  const guided = verdict.dispatch.filter((m) => m.rule?.guidance);
  if (guided.length > 0) {
    lines.push('Guidance for the specific checks that are failing:');
    for (const m of guided) lines.push(`- ${m.name}: ${m.rule!.guidance!.trim()}`);
  }

  // Non-blocking failures still need fixing, but the PR merges with them red.
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

/** Glob match for a check name: `*` any run of characters, `?` exactly one, case-insensitive. Deliberately not a regex — a check name is config read at 3am. */
export function matchesCheckGlob(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : `\\${ch}`));
  return new RegExp(`^${escaped}$`, 'i').test(name);
}
