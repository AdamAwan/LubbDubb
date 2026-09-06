import type { Issue, IssueAppraisal } from '../types.js';
import { isOrphanIssue } from '../issueRelations.js';

/**
 * Where a goal sits on the backlog — its **parent** and its **area path** — and
 * whether the appraisal's proposal for either is still worth putting to a human.
 * These questions inform, never park. Azure only — GitHub has neither field, and
 * every function answers "nothing to ask" for it. → `docs/spec/06-issue-pickup.md`
 */

/** Which of the two placements a proposal or a dismissal is about. */
export type PlacementField = 'parent' | 'areaPath';

/**
 * The project's classification tree as the harness offers it: every node an item
 * may be filed under, and the root meaning *nobody has filed it anywhere*. The
 * root is carried rather than derived — a one-node-deep tree has a root
 * indistinguishable from a leaf by string shape.
 */
export interface AreaPathTree {
  /** The project root node. An item still on it is unclassified. */
  root: string;
  /**
   * The nodes an item may be moved to — the tree **below** the root, in tree order.
   * Empty for a project that has never subdivided, and then nothing is asked.
   */
  paths: string[];
}

/** How many area nodes the appraiser is offered; a tree long enough to be a directory stops being a choice. */
const AREA_PATH_LIMIT = 40;

/** The nodes to offer, and how many were left out — a silently truncated list would read as the project's complete set. */
export function truncateAreaPaths(tree: AreaPathTree): { paths: string[]; omitted: number } {
  const paths = tree.paths.slice(0, AREA_PATH_LIMIT);
  return { paths, omitted: Math.max(0, tree.paths.length - paths.length) };
}

/**
 * Whether this item is still unclassified — asked of the live work item, never
 * anything stored. An Azure work item is never without an area path: unclassified
 * means it sits on the project *root*, so "missing" means equalling the root.
 * The parent's half is {@link isOrphanIssue}. → `docs/spec/06-issue-pickup.md`
 */
function isAreaPathMissing(issue: Issue, tree: AreaPathTree | null): boolean {
  if (issue.areaPath === undefined || tree === null) return false;
  return normalizeAreaPath(issue.areaPath) === normalizeAreaPath(tree.root);
}

/**
 * Area paths compare on a normalised form: Azure echoes whatever separator and
 * casing were sent, so `Contoso\Web` and `contoso/web` are one node. Comparing raw
 * reports classified items as unclassified, silently.
 */
export function normalizeAreaPath(path: string): string {
  return path
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/^\\|\\$/g, '')
    .trim()
    .toLowerCase();
}

/** One placement question, ready to be drawn. */
export interface PlacementAsk {
  field: PlacementField;
  /** The container's number, for `parent`; the node, for `areaPath`. */
  proposedParent: number | null;
  proposedAreaPath: string | null;
}

/**
 * The placement questions still open on this goal, in a fixed order — parent
 * before area path, so the rows do not reorder between draws. The parent
 * question is asked from the fact that the live item hangs off nothing; the
 * area path question is gated on the appraiser's proposal, since it is handed
 * the whole tree as a closed enum. Each ends when the live item gains the
 * field, or on the operator's stored settlement.
 * → `docs/spec/06-issue-pickup.md#the-parent-question-is-the-fact-the-area-path-question-is-the-proposal`
 */
export function placementAsks(
  appraisal: IssueAppraisal | null,
  issue: Issue,
  tree: AreaPathTree | null,
  goalRef: string,
  types: PlacementTypePolicy = {},
): PlacementAsk[] {
  // Scoped to `goal_ref`: an appraisal of text the ticket no longer carries says
  // nothing about it, including whether the parent question was answered.
  const current = appraisal !== null && appraisal.goalRef === goalRef ? appraisal : null;
  const asks: PlacementAsk[] = [];
  if (isOrphanIssue(issue, types.containerTypes, types.parentedTypes) && current?.parentSettledAt == null)
    asks.push({ field: 'parent', proposedParent: current?.proposedParent ?? null, proposedAreaPath: null });
  if (
    current !== null &&
    current.proposedAreaPath !== null &&
    current.areaPathSettledAt === null &&
    isAreaPathMissing(issue, tree)
  )
    asks.push({ field: 'areaPath', proposedParent: null, proposedAreaPath: current.proposedAreaPath });
  return asks;
}

/**
 * The operator's two type policies, as the parent question reads them. One
 * argument rather than two loose lists so a caller cannot supply half: passing
 * only `containerTypes` silently falls back to `DEFAULT_PARENTED_TYPES`.
 */
export interface PlacementTypePolicy {
  /** `issueContainerTypes` — the types that hold work rather than being work. */
  containerTypes?: readonly string[];
  /** `issueParentedTypes` — the types expected to hang off one of the above. */
  parentedTypes?: readonly string[];
}
