import { prState } from '../prHealth.js';
import type { CiStatus, Issue, PullRequest, WorldEvent, WorldEventInput, WorldSnapshot } from '../types.js';

/**
 * Derive the observed state transitions between two consecutive world
 * snapshots. Pure and infra-free (no ids, no clock) so it unit-tests directly;
 * the store stamps id + timestamp when it persists the results.
 *
 * Object identity is by domain id. A newly appeared object emits a single
 * `*_opened`/`*_added` — never its per-field transitions on top — because "it's
 * new" already says everything. A removed object emits nothing: a disappearance
 * isn't a progress signal worth a line in the feed.
 *
 * That last rule is exactly why `pr_merged` used to be unreachable against a real
 * provider. It was defined as the `!before.merged && pr.merged` transition, which
 * requires the PR to still be in the snapshot — and GitHub (`state: 'open'`) and
 * Azure (`status: 'active'`) both drop a PR from the world the moment it merges,
 * so the transition could only ever be observed on the fake. The merge now arrives
 * as an *appearance* in `closedPullRequests` instead, which is a fact the provider
 * actually reports.
 */
/**
 * What a `pr_ci` row says, written and read in one place.
 *
 * A world event stores a kind, a ref and a *sentence*, so the status a CI
 * transition carried survives only inside that sentence — and CI health over time
 * is a fold over exactly those statuses. One matcher serves both directions for
 * the PTY sentinel's reason: two views of the same bytes is the failure that has
 * already been made once here. A reader that re-derived this format for itself
 * would read zero failures, silently, the first time the wording changed.
 */
const CI_SUMMARY = /^PR #\d+ CI (passing|failing|pending|unknown)$/;

function ciSummary(number: number, status: CiStatus): string {
  return `PR #${number} CI ${status}`;
}

/**
 * The status a recorded transition announced, or null when the row is not one —
 * a different kind, or a `pr_ci` row from before this format (there is none, but
 * a parse that cannot fail is a parse that lies).
 */
export function ciStatusOf(event: Pick<WorldEvent, 'kind' | 'summary'>): CiStatus | null {
  if (event.kind !== 'pr_ci') return null;
  const status = CI_SUMMARY.exec(event.summary)?.[1];
  return status === undefined ? null : (status as CiStatus);
}

export function diffWorlds(prev: WorldSnapshot, next: WorldSnapshot): WorldEventInput[] {
  const events: WorldEventInput[] = [];

  const prevPrs = byId(prev.pullRequests);
  for (const pr of next.pullRequests) {
    const before = prevPrs.get(pr.id);
    if (!before) {
      events.push({ kind: 'pr_opened', ref: prRef(pr), summary: `PR #${pr.number} opened: ${pr.title}` });
      continue;
    }
    if (before.ciStatus !== pr.ciStatus) {
      events.push({ kind: 'pr_ci', ref: prRef(pr), summary: ciSummary(pr.number, pr.ciStatus) });
    }
    if (!before.approved && pr.approved) {
      events.push({ kind: 'pr_approved', ref: prRef(pr), summary: `PR #${pr.number} approved` });
    }
    if (!before.mergeable && pr.mergeable) {
      events.push({ kind: 'pr_mergeable', ref: prRef(pr), summary: `PR #${pr.number} is mergeable` });
    }
    if (!before.merged && pr.merged) {
      events.push({ kind: 'pr_merged', ref: prRef(pr), summary: `PR #${pr.number} merged` });
    }
    const seen = new Set(before.unresolvedComments.map((c) => c.id));
    for (const comment of pr.unresolvedComments) {
      if (!seen.has(comment.id)) {
        events.push({ kind: 'pr_comment', ref: prRef(pr), summary: `PR #${pr.number}: ${comment.author} commented` });
      }
    }
  }

  // PRs that have left the open set. A row is news the first cycle it appears
  // here and never again: it lingers for the whole retention window, so keying
  // off "not in the previous closed list" is what keeps one merge to one event.
  const prevClosed = byId(prev.closedPullRequests ?? []);
  for (const pr of next.closedPullRequests ?? []) {
    if (prevClosed.has(pr.id)) continue;
    const merged = prState(pr) === 'merged';
    // The fake marks a PR merged in place before it ever closes, so the open-list
    // transition above may already have announced this one.
    if (merged && prevPrs.get(pr.id)?.merged) continue;
    events.push(
      merged
        ? { kind: 'pr_merged', ref: prRef(pr), summary: `PR #${pr.number} merged` }
        : { kind: 'pr_closed', ref: prRef(pr), summary: `PR #${pr.number} closed without merging` },
    );
  }

  const prevIssues = byId(prev.issues);
  for (const issue of next.issues) {
    const before = prevIssues.get(issue.id);
    if (!before) {
      events.push({
        kind: 'issue_opened',
        ref: issueRef(issue),
        summary: `Issue #${issue.number} opened: ${issue.title}`,
      });
      continue;
    }
    // Kept, and unreachable on every real deployment: the transition needs an
    // in-place open→closed, and both real issue providers snapshot the open set
    // only — a closed issue leaves `issues` and removals are silent. `pr_merged`
    // has the same defect and arrives on `closedPullRequests` instead; there is no
    // closed-issue list, so the closure signal a reader wants is the **ticket
    // mirror**, never this. Retained rather than retired for `pr_merged`'s reason:
    // it is the honest reading of what a provider reporting closed issues would
    // deliver. → `docs/spec/03-world-model.md`
    if (before.state === 'open' && issue.state === 'closed') {
      events.push({ kind: 'issue_closed', ref: issueRef(issue), summary: `Issue #${issue.number} closed` });
    }
    if (before.linkedPrNumber === null && issue.linkedPrNumber !== null) {
      events.push({
        kind: 'issue_linked',
        ref: issueRef(issue),
        summary: `Issue #${issue.number} linked to PR #${issue.linkedPrNumber}`,
      });
    }
  }

  return events;
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

const prRef = (pr: PullRequest): string => `pr:${pr.number}`;
const issueRef = (issue: Issue): string => `issue:${issue.number}`;
