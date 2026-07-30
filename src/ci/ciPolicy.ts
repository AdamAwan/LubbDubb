import type { CiCheck } from '../types.js';

/**
 * Per-check CI policy: what the harness does about *which* check went red.
 *
 * `ciStatus` is one aggregate verdict for a whole PR, so rule 1 had exactly one
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
 */

/** What a failing check makes the harness do. */
type CiFailureAction = 'dispatch' | 'ignore' | 'escalate';

/** Every legal `onFailure` value, so config validation and the type can't drift. */
const CI_FAILURE_ACTIONS: readonly CiFailureAction[] = ['dispatch', 'ignore', 'escalate'];

/** One operator-configured rule, matched against a failing check's name. */
interface CiCheckRule {
  /**
   * Glob against the check name: `*` any run of characters, `?` one. Matched
   * case-insensitively, because a check name is a label a human typed into
   * another system and getting its case wrong here would fail silently.
   */
  match: string;
  /**
   * What to do when a check matching {@link match} fails. Defaults to `ignore`:
   * a rule is written to carve an exception out of the default dispatch, so the
   * common reason to name a check at all is to stop acting on it.
   */
  onFailure?: CiFailureAction;
  /**
   * Appended to the agent's prompt when this check is among the failures — the
   * place to name a skill, a runbook, or a constraint. Only meaningful with
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
  });
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
 * nothing. Rule 1 does not fire on one either — `ciNeedsAttention` excludes them
 * by the same rule — so the two cannot disagree.
 */
export function classifyCiFailures(checks: CiCheck[] | undefined, policy: CiPolicy): CiVerdict {
  // Advisory checks are dropped up front, so no rule — not even `match: '*'` —
  // can claim one. They are reported for visibility and belong to whatever
  // already models the signal at higher fidelity (a comment policy's threads are
  // rule 2b's, with the author and body attached).
  const failing = (checks ?? []).filter((c) => c.status === 'failing' && !c.advisory);
  if (failing.length === 0) {
    return { actionable: true, dispatch: [], escalate: [], ignored: [], urgent: false };
  }

  const dispatch: CiMatch[] = [];
  const escalate: CiMatch[] = [];
  const ignored: CiMatch[] = [];
  let urgent = false;

  for (const check of failing) {
    const rule = policy.checks.find((r) => matchesCheckGlob(r.match, check.name)) ?? null;
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
