/**
 * The `issue:<n>` origin vocabulary, classified in one place.
 *
 * Everything the harness dispatches for an issue is keyed on an origin in this
 * subtree, and the origins mean two materially different things. Some are the
 * **work**: the pickup root `issue:<n>` and a plan's parts `issue:<n>:part:<slug>`
 * are where a branch is cut, a PR is written, a goal is delivered. The rest are the
 * harness **deliberating** about the issue — the planner asking what shape the work
 * is, the appraiser asking whether the goal can be worked from at all. A deliberation
 * agent leaves a task row behind exactly as a working one does, and nothing about
 * the ref shape says which it was.
 *
 * That distinction had no representation, and the bug it caused is why this exists.
 * `hasPriorWork` matched the whole subtree, so a planner's own task read as work
 * having been done: an issue the planner routed to `single` — one PR will do,
 * nothing built yet — was assessed rather than picked up, the assessor honestly
 * reported nothing delivered, the shortfall replanned, and the issue cycled through
 * the funnel forever without a line of its work being written.
 *
 * So the deliberation origins are enumerated here rather than each predicate
 * carrying its own exclusion. `hasWorkStarted` already made this exclusion for the
 * appraisal's own origin, one special case at a time; this is that argument generalised,
 * and the one place a new origin has to be classified.
 */

/**
 * What an origin under `issue:<n>` is, or null when the ref names something else
 * entirely — another issue, a PR, a job.
 *
 * `evidence` is its own answer rather than being folded into `work`: an assessment
 * is not work on the issue, but it only ever happens *downstream* of work, so it
 * proves some was done. Collapsing the two would lose the reason.
 */
type IssueOriginRole = 'work' | 'evidence' | 'deliberation' | 'unrecognised';

/**
 * The origins where the harness is deciding *about* the work rather than doing it.
 * A task on one of these says the issue has been thought about, never that anything
 * was built.
 */
const DELIBERATION_SUFFIXES = ['plan', 'appraisal'];

/** The origins that are the work itself, as suffix prefixes under `issue:<n>:`. */
const WORK_SUFFIX_PREFIXES = ['part:'];

/**
 * The origins that are not the work but prove it happened. Rule `issue-assess` only fires once
 * work has started and rule `issue-retro` only once a goal has been parked as delivered, so
 * neither can exist without some.
 */
const EVIDENCE_SUFFIXES = ['assess', 'retro'];

/**
 * The evidence origins that name something *within* the issue, so they are
 * prefixes rather than whole suffixes — the two validation origins, one of each
 * per check: `validate:<checkId>`, a check the operator handed to the fleet to
 * run, and `validate-failure:<checkId>`, a check that was run and failed and is
 * being looked into.
 *
 * Evidence rather than work for {@link EVIDENCE_SUFFIXES}' reason and rather
 * more strictly: rules `validate-check` and `validation-failed` both fire only
 * for a goal already parked as delivered, so a task on one of these cannot exist
 * unless work was done and finished. Both build nothing and open no pull request
 * — they are dispatched into a read-only checkout.
 */
const EVIDENCE_SUFFIX_PREFIXES = ['validate:', 'validate-failure:'];

/**
 * Classify a task's origin against an issue.
 *
 * An **unrecognised** suffix is deliberately its own answer, and callers must decide
 * what to do with it rather than having a default chosen for them. The defect above
 * happened because `issue:<n>:plan` was added and an implicit "everything under the
 * subtree counts" answered for it silently; a name is what forces the next one to be
 * decided instead. Per the repo's discipline, callers should fail toward the visible
 * mistake — for `hasPriorWork` that is not counting it, so an issue is picked up
 * (a redundant agent, which an operator sees) rather than parked (which they do not).
 */
export function issueOriginRole(issueNumber: number, originRef: string | null): IssueOriginRole | null {
  const root = `issue:${issueNumber}`;
  if (originRef === root) return 'work';
  const prefix = `${root}:`;
  if (originRef === null || !originRef.startsWith(prefix)) return null;

  const suffix = originRef.slice(prefix.length);
  if (WORK_SUFFIX_PREFIXES.some((p) => suffix.startsWith(p))) return 'work';
  if (EVIDENCE_SUFFIXES.includes(suffix)) return 'evidence';
  if (EVIDENCE_SUFFIX_PREFIXES.some((p) => suffix.startsWith(p))) return 'evidence';
  if (DELIBERATION_SUFFIXES.includes(suffix)) return 'deliberation';
  return 'unrecognised';
}

/**
 * The obstacle a dispatch is a repair for, or null for any other origin.
 *
 * Here rather than beside the rule that raises it because this module is where an
 * origin is **classified**, and an origin nothing classifies is one that reads as
 * `unrecognised` wherever it is asked about: it stops expanding under a goal's
 * priority flag, and its spend files under "other". Neither is red, which is the
 * whole reason the classification lives in one place instead of in each predicate.
 *
 * `obstacle:<id>` is not under the `issue:<n>` subtree and so is not one of
 * {@link issueOriginRole}'s answers — it names no issue. It is a second, tiny
 * vocabulary rather than a member of the first, and the callers that ask about
 * both ask both.
 * → `docs/spec/32-obstacles.md#ownership`
 */
export function obstacleOriginId(originRef: string | null): string | null {
  const match = /^obstacle:([A-Za-z0-9_-]+)$/.exec(originRef ?? '');
  return match ? match[1]! : null;
}
