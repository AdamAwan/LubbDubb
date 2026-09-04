import type { Decision, Escalation } from '../types.js';
import { DISPATCH_RULES, type DispatchRuleId } from './rules.js';

/**
 * Admission: what becomes of something a rule proposed.
 *
 * A rule answers "is there work here". This answers "may it proceed, and if not,
 * what does the operator get told instead" — a different question, asked of every
 * proposal, in the same way, whichever rule made it. It is not ordered
 * per-feature and it takes no place in the pipeline.
 *
 * The split exists because these were previously **four representations of one
 * idea**, none of which knew about the others:
 *
 * - `branch-notify` and `cooldown-escalate` were entries in the rule registry,
 *   which made a throttled pickup audit as `cooldown-escalate` and lose the fact
 *   that it was `issue-pickup` that got throttled. They are still registry
 *   entries — a persisted id must resolve — but they no longer *displace* the
 *   proposer: `decisions.admission` is their column and `decisions.rule` keeps
 *   naming the rule, with `AdmissionId` making the two vocabularies distinct
 *   types so a rule id cannot land in the outcome column.
 * - `cooldown` / `capped` / `unapproved` were a `held` string on the candidate.
 * - `waiting` was decided inline by the headroom cut.
 * - **Suppression was not represented at all** — a rule superseded by an earlier
 *   one `continue`d, so the candidate vanished with no queue entry and no reason
 *   anywhere. That is the same invisibility `capped` was introduced to fix, and
 *   {@link HeldReason} is where it stops being possible: a candidate is held for
 *   a named reason or it is dispatched, and every held reason reaches the queue.
 */

/**
 * Why a proposed candidate did not become a dispatch this cycle. Every one of
 * these reaches the cockpit's Up next queue — that is the whole contract, and
 * what makes "nothing happened and nobody can say why" unrepresentable.
 *
 * None of them reaches `decisions.admission`, and that is not an omission: a
 * held candidate was **never executed**, so there is no decision row for it to
 * land on. Only the two admissions that emit an action of their own
 * (`AdmissionId` in `rules.ts`) are ever recorded there.
 */
type HeldReason =
  /** The per-origin re-dispatch throttle (see `dispatchVerdict`). */
  | 'cooldown'
  /** A per-plan concurrency limit (`maxConcurrentPartsPerIssue`). */
  | 'capped'
  /** The plan's decomposition is still a proposal nobody has accepted. */
  | 'unapproved'
  /** An earlier rule in the pipeline claimed this issue for a different question. */
  | 'superseded'
  /**
   * An accepted order for this story's Feature puts something else first, and that
   * something has not pushed a branch yet. → `docs/spec/33-story-sequencing.md`
   */
  | 'sequenced'
  /** No fleet headroom — the only reason decided by the cut rather than by a rule. */
  | 'waiting';

/** The held reasons a rule itself can decide. `waiting` belongs to the headroom cut. */
export type RuleHeld = Exclude<HeldReason, 'waiting'>;

/** Where a candidate sits relative to the headroom cut. */
export type QueueStatus = 'dispatching' | HeldReason;

/**
 * Has this origin already been put to a human, and does the ask still stand?
 *
 * Three escalating rules need this and each had its own copy, with a comment on
 * two of them pointing at the third as the reason. The two halves cover each
 * other's blind spot and neither is sufficient alone: an **open inbox item** is
 * the visible state, but it outlives the recent-decision window; a **recent
 * executed escalation** covers the case where the item has since been answered
 * while the world has not moved. Ask for both, or the same question is put to the
 * same person twice about a condition that by construction does not clear itself.
 */
export function askedAlready(
  originRef: string,
  openEscalations: readonly Escalation[],
  recentDecisions: readonly Decision[],
): boolean {
  if (openEscalations.some((e) => e.context.originRef === originRef)) return true;
  return recentDecisions.some(
    (d) =>
      d.outcome === 'executed' &&
      d.action.type === 'escalate_to_human' &&
      (d.action.context as { originRef?: unknown } | undefined)?.originRef === originRef,
  );
}

/**
 * The queue line for a candidate an earlier rule claimed.
 *
 * One function rather than a string built at each suppression site: the three
 * sites are in different rules and would drift into describing the same event
 * three ways, which is the drift the registry itself was just cured of. The rule
 * is named by its registry `name` rather than its id — the operator reading the
 * queue has not memorised the ids.
 */
export function supersededReason(by: DispatchRuleId, what: string): string {
  return `${what} Held: superseded this cycle by "${DISPATCH_RULES[by].name}", which is asking a question about the same issue.`;
}
