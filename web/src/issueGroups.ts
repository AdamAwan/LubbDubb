import type { Issue, IssueRelative } from './types.js';

/**
 * The World panel's second axis, beside the watch buckets: **what a thing is**,
 * rather than whether the harness is allowed to touch it.
 *
 * A flat list treats a Feature as one more row to scan past, which it is not —
 * nothing is ever dispatched at one, so a list mixing them with workable items
 * asks an operator to remember which is which on every read. Grouping says it
 * structurally: a feature is a *heading*, and the things under it are the work.
 *
 * The grouping is pure over the already-filtered rows, so the watch tab still
 * decides what is visible and this only decides how what remains is arranged.
 */

/**
 * What a group *is*, which decides whether it draws a heading at all.
 *
 * `untracked` is the one that matters: an item whose provider reports no
 * hierarchy is not an orphan, and filing it under "no parent feature" would
 * accuse a GitHub issue of missing something its tracker never had. It draws as
 * a plain, unheaded, unindented list — today's rendering, unchanged.
 */
type IssueGroupKind = 'feature' | 'orphans' | 'untracked';

/** One feature and the visible items under it. */
interface IssueGroup {
  kind: IssueGroupKind;
  /**
   * The feature these items hang under, or null for the trailing group of items
   * with no parent. Taken from the container issue itself when the world holds
   * one, and otherwise from a child's `parent` — which is the ordinary case, since
   * a tag or assignee filter usually leaves the Feature out of the item list
   * entirely while its stories are all present. Null on both headless kinds.
   */
  feature: IssueRelative | null;
  /**
   * The feature's **own row**, when the world holds it as an issue. Non-null means
   * the header can carry its controls (watch/ignore, conclusion) exactly as a row
   * would; null means the header is a label reconstructed from a relation, and
   * there is nothing to operate on.
   */
  featureIssue: Issue | null;
  /** The workable items under that feature, in issue order. Never contains a container. */
  issues: Issue[];
}

/**
 * Arrange rows under their features — or refuse, for a tracker that has none.
 *
 * **Null means "render the flat list"**, and it is the answer for every GitHub and
 * fake world: no item reports a type or a parent, so there is no tree, and
 * inventing a single "no parent feature" group for every issue would be a
 * structure claiming a fact the tracker never stated. The refusal is what keeps
 * this invisible on the providers it does not apply to.
 *
 * Group order is by feature number, with the parentless group **last** — it is
 * the exception rather than a peer, and burying it between two features is how it
 * stops being read. Items inside a group keep issue order.
 */
export function groupByFeature(issues: readonly Issue[], isContainer: (issue: Issue) => boolean): IssueGroup[] | null {
  const tracked = issues.some((i) => i.parent !== undefined || isContainer(i));
  if (!tracked) return null;

  const groups = new Map<number, IssueGroup>();
  const orphans: Issue[] = [];
  const untracked: Issue[] = [];

  const ensure = (feature: IssueRelative): IssueGroup => {
    const existing = groups.get(feature.number);
    if (existing) return existing;
    const group: IssueGroup = { kind: 'feature', feature, featureIssue: null, issues: [] };
    groups.set(feature.number, group);
    return group;
  };

  // Containers first, so a feature the world *does* hold owns its own header
  // before any child's `parent` summary can create a headerless one for it.
  for (const issue of issues) {
    if (!isContainer(issue)) continue;
    const group = ensure({
      number: issue.number,
      title: issue.title,
      issueType: issue.issueType ?? '',
      workItemState: issue.workItemState ?? '',
      state: issue.state,
    });
    group.featureIssue = issue;
  }

  for (const issue of issues) {
    if (isContainer(issue)) continue;
    if (issue.parent) ensure(issue.parent).issues.push(issue);
    // `null` is the tracker saying "no parent"; `undefined` is it having no
    // opinion. Only the first is an orphan, and conflating them is how a flat
    // tracker's every issue ends up under a heading accusing it of a gap.
    else if (issue.parent === null) orphans.push(issue);
    else untracked.push(issue);
  }

  const byNumber = (a: Issue, b: Issue): number => a.number - b.number;
  const features = [...groups.values()].sort((a, b) => (a.feature?.number ?? 0) - (b.feature?.number ?? 0));
  for (const group of features) group.issues.sort(byNumber);
  const trailing: IssueGroup[] = [];
  if (untracked.length > 0) {
    trailing.push({ kind: 'untracked', feature: null, featureIssue: null, issues: [...untracked].sort(byNumber) });
  }
  if (orphans.length > 0) {
    trailing.push({ kind: 'orphans', feature: null, featureIssue: null, issues: [...orphans].sort(byNumber) });
  }
  // Headless items first, then the tree, then the exception. A mixed world is
  // only ever a demo or a migration, but putting untracked rows *above* the
  // features keeps the flat list where it has always been for anyone reading a
  // world that has no tree at all.
  return [
    ...trailing.filter((g) => g.kind === 'untracked'),
    ...features,
    ...trailing.filter((g) => g.kind === 'orphans'),
  ];
}

/**
 * What a feature's heading says about its contents.
 *
 * Two numbers, because a heading reporting only one of them is wrong in a way an
 * operator cannot see: `shown` is the rows underneath — which the watch tab and
 * the closed-item filter both narrow — and `children` is how many the feature
 * actually has, known only when the world holds the feature itself. Saying
 * "3 children" above two rows reads as a missing row; saying "2" above a feature
 * with three hides one. So the heading says both, and only when they differ.
 */
export function groupProgress(group: IssueGroup): { shown: number; children: number | null } {
  return { shown: group.issues.length, children: group.featureIssue?.children?.length ?? null };
}
