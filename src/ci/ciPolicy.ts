import type { CiCheck } from '../types.js';

/**
 * Per-check CI policy: what the harness does about *which* check went red.
 *
 * `ciStatus` is one aggregate verdict for a whole PR, so rule `pr-ci-failing` had exactly one
 * response to every failure — dispatch a code agent with the generic fix prompt.
 * That is the right default and the wrong only option: a lint failure has a
 * house-specific fix, a flaky suite wants latitude, and a red deploy check owned
 * by another team is not fixable by an agent at all. Dispatching into that last
 * case burns the origin's attempt cap and ends in a cooldown escalation blaming
 * the agent for a wall it was never going to get through.
 *
 * So the failing *checks* are carried on the PR now, and this decides per check.
 * Pure over `(checks, policy)` — the dispatcher reads the verdict and nothing
 * else, and `prHealth` renders the same verdict, so the cockpit and the rule can
 * never disagree about why no agent came.
 *
 * A rule can also watch a check in a state that is *not* failing — the blocking
 * gate that sits `pending` until a human runs something. That is a separate walk
 * ({@link classifyWatchedChecks}) over the same rules, kept apart from the failing
 * verdict every merge-facing reader consumes.
 */

/** What a failing check makes the harness do. */
export type CiFailureAction = 'dispatch' | 'ignore' | 'escalate';

/** Every legal `onFailure` value, so config validation and the type can't drift. */
const CI_FAILURE_ACTIONS: readonly CiFailureAction[] = ['dispatch', 'ignore', 'escalate'];

/**
 * The check states a rule may watch.
 *
 * `passing` is deliberately not one. A check that passed asks nothing of anyone,
 * so a rule naming it could never fire, and {@link validateCiPolicy} says so
 * rather than accepting config that does nothing.
 */
const CI_WATCH_STATES = ['failing', 'pending'] as const;

export type CiWatchState = (typeof CI_WATCH_STATES)[number];

/** What a rule watches when it names no states — today's behaviour, exactly. */
const DEFAULT_WATCH_STATES: readonly CiWatchState[] = ['failing'];

/** One operator-configured rule, matched against a check's name and its state. */
interface CiCheckRule {
  /**
   * Glob against the check name: `*` any run of characters, `?` one. Matched
   * case-insensitively, because a check name is a label a human typed into
   * another system and getting its case wrong here would fail silently. Matched
   * against every alias the provider reports for the check too — see
   * {@link CiCheck.aliases}.
   */
  match: string;
  /**
   * Which check states this rule claims. Defaults to `['failing']`, so a config
   * written before this existed behaves exactly as it did.
   *
   * **It scopes the whole rule**, rather than adding to the failing case: a rule
   * is matched on the `(glob, state)` pair, so a rule listing only `pending` does
   * not claim the same check when it goes red, and the ordinary first-match walk
   * then hands the red one to a later rule — or, matching none, to the unmatched
   * default. That is what lets one check have two rules, which is the only way to
   * say "fix it when it breaks, and run the gate when it stalls".
   *
   * `pending` is here for a blocking check that never resolves on its own: an
   * Azure status policy waiting on a command somebody has to run. Absent a rule
   * and absent {@link CiCheck.expired}, nothing else in the harness reads a
   * pending check, so the pull request sits `elsewhere` / "CI still running"
   * forever.
   *
   * A `pending`-only rule with `onFailure: 'ignore'` is therefore the lever for
   * the opposite need: muting the expiry default on a check that expires on every
   * push, while leaving its genuine failures on the dispatching default.
   */
  states?: CiWatchState[];
  /**
   * What to do when a check this rule claims is in one of its {@link states}.
   * Defaults to `ignore`: a rule is written to carve an exception out of the
   * default dispatch, so the common reason to name a check at all is to stop
   * acting on it.
   *
   * **Named `onFailure` because that is what every deployed config calls it.** It
   * reads narrow now that a rule can watch a check that is not failing — "on
   * match" would be the honest name — but renaming a config key to improve a noun
   * breaks every file in the field and every `describeCiPolicy` payload, in
   * exchange for nothing an operator can do differently. The name is history; the
   * behaviour is the whole rule's action, whichever state triggered it.
   */
  onFailure?: CiFailureAction;
  /**
   * Appended to the agent's prompt when this check is among the ones that fired —
   * the place to name a skill, a runbook, or a constraint. Only meaningful with
   * `onFailure: 'dispatch'`; `loadConfig` refuses the other combination rather
   * than dropping the text silently.
   */
  guidance?: string;
  /**
   * Sort this PR's concern ahead of every other PR concern this cycle. A
   * boolean, not a rank: the harness already has one numeric priority axis
   * (`priority_overrides`), and a second one claiming to order the same queue is
   * two answers to one question.
   */
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
  /**
   * The check is waiting on a run nobody has started ({@link CiCheck.expired}).
   * Only ever set in {@link CiWatchVerdict}, and the one entry there that may
   * carry a null {@link rule} — it is watched by the provider's own report rather
   * than by an operator naming it.
   */
  expired?: boolean;
}

export interface CiVerdict {
  /**
   * Dispatch an agent for this PR's CI. True when something actionable is
   * failing — and true when the provider reported no per-check detail at all,
   * which is what keeps a project with no `ci` config, and the `fake` provider,
   * behaving exactly as they did before this existed.
   */
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

/**
 * Reject a policy that cannot mean what it says, at load rather than at 3am.
 *
 * The trap worth closing is `guidance` on a rule that isn't dispatching: the
 * operator has written instructions for an agent that will never be sent, and
 * the words vanish with nothing said. Same fail-fast discipline as
 * `loadPromptTemplates` refusing an override that names an unknown placeholder.
 */
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
        // `passing` is the near-miss worth naming: it is a real check state, so an
        // operator can reasonably expect it here, and the reason it is refused is
        // not a typo but that nothing could ever act on it.
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
    // A rule that watches no failing state is only ever looked at by
    // `classifyWatchedChecks`, which dispatches or does nothing — so `ignore` there
    // used to be refused as a rule that could never fire. It fires now: the
    // expiry default watches an **expired** check with no rule naming it, and a
    // pending-only `ignore` rule is the one way to shadow that default without
    // also giving up the agent fix when the same check goes genuinely red (which
    // is what `states: ['failing', 'pending']` costs).
    //
    // `escalate` is still refused, for the reason that has not changed: it has no
    // arm to run in. Rule `pr-ci-blocked` asks about a *red* PR whose failures are
    // all held, and stretching it over a waiting gate would need its own
    // once-only bookkeeping and its own wording.
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

/**
 * Does this rule claim this check? The `(glob, state)` pair, in one place, so the
 * failing walk and the watched walk cannot answer it differently.
 *
 * The glob is tried against every name the provider reports for the check, so a
 * rule written against the label a human can see on the pull request page matches
 * the same check as one written against the key the harness stores it under.
 */
function ruleClaims(rule: CiCheckRule, check: CiCheck): boolean {
  if (!(ruleStates(rule) as readonly string[]).includes(check.status)) return false;
  return [check.name, ...(check.aliases ?? [])].some((name) => matchesCheckGlob(rule.match, name));
}

/**
 * Classify a failing PR's checks against the policy.
 *
 * Call only when the PR's aggregate `ciStatus` is `failing` — this reads the
 * per-check list and says what to do about it, it does not re-derive whether the
 * PR is red.
 *
 * Two silences are deliberately different. A provider that reports **no checks**
 * (`undefined`/empty) is missing detail, not reporting health, so the verdict is
 * actionable with empty lists: today's behaviour, unchanged. A check matching
 * **no rule** is actionable *and named*, so a CI job added next week is fixed by
 * the harness rather than silently parking every red PR forever.
 *
 * A third case is not a silence at all: an **advisory** check is dropped before
 * anything is decided, so a PR whose only failure is advisory classifies into
 * nothing. Rule `pr-ci-failing` does not fire on one either — `ciNeedsAttention` excludes them
 * by the same rule — so the two cannot disagree.
 */
export function classifyCiFailures(checks: CiCheck[] | undefined, policy: CiPolicy): CiVerdict {
  // Advisory checks are dropped up front, so no rule — not even `match: '*'` —
  // can claim one. They are reported for visibility and belong to whatever
  // already models the signal at higher fidelity (a comment policy's threads are
  // rule `pr-review-comment`'s, with the author and body attached).
  const failing = (checks ?? []).filter((c) => c.status === 'failing' && !c.advisory);
  if (failing.length === 0) {
    return { actionable: true, dispatch: [], escalate: [], ignored: [], urgent: false };
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
  /**
   * Watched checks an agent should be sent for. Every entry either has a rule
   * that dispatches — a rule with `ignore` drops the check from this walk
   * entirely, and `escalate` is refused at load, so there is no held or muted
   * list here to mirror {@link CiVerdict}'s — or is an **expired** check no rule
   * claimed, which is watched on the provider's word.
   */
  watched: CiMatch[];
  /** Any watched check's rule asked to jump the queue. */
  urgent: boolean;
}

/**
 * Classify the checks that are **not failing** against the policy — the gate that
 * sits `pending` until something outside the harness acts on it.
 *
 * Deliberately a second function rather than a widening of
 * {@link classifyCiFailures}. That verdict is read by `prHealth`, by
 * `prAttention`'s `ciReading` and by the dispatcher's red-CI arm, all three asking
 * *what is wrong with this build*; folding a waiting check into it would have a
 * pending gate answering "CI failing" to a question about a merge. The aggregate
 * `ciStatus` is untouched for the same reason — a watched check can start an agent
 * and can move nothing else.
 *
 * Advisory checks are dropped first, exactly as they are there: no rule, not even
 * `match: '*'`, may claim one, in any state.
 *
 * An **expired** check ({@link CiCheck.expired}) is watched with no rule naming
 * it — the one place this walk has a default, and it mirrors the failing side's:
 * a check nobody configured is the harness's to act on. It is not a widening of
 * `states`, which asks *whether an operator wants this watched*; expiry is the
 * provider stating as fact that no run is in flight and none will start on its
 * own, which is not an opinion config can improve on. Without it the case needs
 * `states: ['pending']` on the build checks, and that same rule then fires on
 * every build that is merely mid-flight — an agent sent to release a gate that
 * was about to release itself.
 *
 * An operator can still take it back: a rule claiming the check in `pending`
 * with a non-dispatch action shadows the default, exactly as first-match-wins
 * shadows the failing side's.
 */
export function classifyWatchedChecks(checks: CiCheck[] | undefined, policy: CiPolicy): CiWatchVerdict {
  const watched: CiMatch[] = [];
  let urgent = false;

  for (const check of checks ?? []) {
    if (check.status === 'failing' || check.advisory) continue;
    const rule = policy.checks.find((r) => ruleClaims(r, check));
    // An earlier rule claiming the check with a non-dispatch action shadows a
    // later one, exactly as first-match-wins does on the failing side. That is
    // the operator's lever for exempting one check from a broad watch glob — and,
    // for an expired check, from the default below.
    if (rule && (rule.onFailure ?? 'ignore') !== 'dispatch') continue;
    if (!rule && !check.expired) continue;
    const match: CiMatch = { name: check.name, rule: rule ?? null, blocking: check.blocking };
    if (check.expired) match.expired = true;
    watched.push(match);
    if (rule?.urgent) urgent = true;
  }

  return { watched, urgent };
}

/**
 * The per-check briefing appended to the agent's waiting-gate prompt.
 *
 * **Appended, never interpolated**, for the reason {@link ciFailureNote} states.
 * The check names are the load-bearing half: the prompt can say a gate is waiting,
 * but only the operator's guidance can say what clears it, and an agent that
 * cannot see which check it is has nothing to act on.
 */
export function ciWatchNote(verdict: CiWatchVerdict): string {
  if (verdict.watched.length === 0) return '';
  const lines = ['The checks that are waiting:'];
  for (const m of verdict.watched) {
    const guidance = m.rule?.guidance?.trim();
    lines.push(`- ${m.name}${guidance ? `: ${guidance}` : ''}`);
  }

  // An expired check is the one waiting state whose cause is known, so it is
  // named: the prompt tells the agent to do what the guidance says and nothing
  // else, and an expired check reached here precisely because no operator wrote
  // any. Without this it has a check name and no idea what would release it.
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

  // Same warning as on the failing side, for the same reason: without it an agent
  // reads the pull request being mergeable as evidence the gate cleared.
  const optional = verdict.watched.filter((m) => m.blocking === false).map((m) => m.name);
  if (optional.length > 0) {
    lines.push(
      `These do not block the merge — ${optional.join(', ')}. Do the work anyway; they are named here so you do ` +
        'not read the pull request being mergeable as the gate having cleared.',
    );
  }

  return `\n\n${lines.join('\n')}`;
}

/**
 * Whether the harness should put this red PR to a human instead of an agent.
 *
 * Only when nothing is dispatchable: an agent is about to work the branch
 * anyway, so an escalation alongside it asks a human to look at a PR that is
 * already being handled. The held checks reach that agent through
 * {@link ciFailureNote} instead.
 */
export function ciNeedsHuman(verdict: CiVerdict): boolean {
  return !verdict.actionable && verdict.escalate.length > 0;
}

/**
 * The per-check briefing appended to the agent's CI-fix prompt.
 *
 * **Appended, never filled into a `{placeholder}`.** `pr-ci-fix` is an operator-
 * overridable template and `loadPromptTemplates` only rejects *unknown*
 * placeholders, so an override written before this feature would silently drop
 * every word of the operator's own guidance — on exactly the deployments that
 * customised most. Appending has no fallback to get wrong.
 *
 * Held checks are named rather than hidden: an agent that cannot see them
 * watches CI stay red after a correct fix and starts chasing a failure it was
 * never meant to touch.
 */
export function ciFailureNote(verdict: CiVerdict): string {
  const lines: string[] = [];

  const guided = verdict.dispatch.filter((m) => m.rule?.guidance);
  if (guided.length > 0) {
    lines.push('Guidance for the specific checks that are failing:');
    for (const m of guided) lines.push(`- ${m.name}: ${m.rule!.guidance!.trim()}`);
  }

  // A failure the provider says does not block completion is still a failure to
  // fix, but the PR will merge with it red — so an agent that is not told cannot
  // read "the PR is mergeable" as evidence its fix landed.
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

/**
 * Glob match for a check name: `*` = any run of characters, `?` = exactly one.
 *
 * Case-insensitive, and the only two metacharacters — everything else in the
 * pattern is a literal. No regex: a check name is config an operator writes
 * once and reads at 3am, and the debugging cost of a regex there is not repaid
 * by the matrix-suffix case (`test (*)`) that a glob already covers.
 */
export function matchesCheckGlob(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : `\\${ch}`));
  return new RegExp(`^${escaped}$`, 'i').test(name);
}
