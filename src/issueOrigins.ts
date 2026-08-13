/**
 * The `issue:<n>` origin vocabulary, classified in one place.
 *
 * Everything the harness dispatches for an issue is keyed on an origin in this
 * subtree, and the origins mean two materially different things. Some are the
 * **work**: the pickup root `issue:<n>` and a plan's parts `issue:<n>:part:<slug>`
 * are where a branch is cut, a PR is written, a goal is delivered. The rest are the
 * harness **deliberating** about the issue — the planner asking what shape the work
 * is, the assayer asking whether the goal can be worked from at all. A deliberation
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
 * assay's own origin, one special case at a time; this is that argument generalised,
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
const DELIBERATION_SUFFIXES = ['plan', 'assay'];

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
 * prefixes rather than whole suffixes — today only `validate:<checkId>`, one
 * origin per validation check the operator handed to the fleet.
 *
 * Evidence rather than work for {@link EVIDENCE_SUFFIXES}' reason and rather
 * more strictly: rule `validate-check` fires only for a goal already parked as
 * delivered, so a task on one of these cannot exist unless work was done and
 * finished. It builds nothing and opens no pull request.
 */
const EVIDENCE_SUFFIX_PREFIXES = ['validate:'];

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
