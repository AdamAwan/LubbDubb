import type { Issue, IssueAssay } from '../types.js';

/**
 * Where a goal sits on the backlog — its **parent** and its **area path** — and
 * whether the assay's proposal for either is still worth putting to a human.
 *
 * ## The gap this closes
 *
 * Both fields can be missing on an item the fleet then works perfectly. Nothing
 * checks either, and both fail the same silent way: the work lands, the pull
 * request merges, and the ticket is invisible to whoever plans the backlog —
 * rolled up to nothing, and on no team's board. Neither costs anything at
 * dispatch, which is exactly why nothing catches it.
 *
 * ## Why it informs and never parks
 *
 * The goal-profile gate (issue #342) blocks because a wrong profile spends real
 * money irreversibly before anyone sees the result, so it has to be settled
 * first. Nothing here is like that: a missing parent costs nothing at dispatch
 * and is fixable at any point afterwards. So {@link assayHold} is not touched and
 * neither is `goalFingerprint` — this is read only where it is drawn.
 *
 * ## Derived visibility, not stored expiry
 *
 * The question is asked while the **live** work item still lacks the field, and
 * that is the whole of its lifetime. An operator who sets the parent by hand in
 * the tracker ends the question on the next world read: no timer, no world event
 * to have missed, and nothing to remember. This is `assayHold`'s fingerprint arm
 * pointed at a different fact — the state of the item rather than of its text —
 * and it is a lookup against current state for the same reason.
 *
 * The one thing that *is* stored is the operator's answer
 * ({@link IssueAssay.parentSettledAt}), which exists for the third of the three:
 * "this goal wants no parent" changes nothing out there for a later read to find,
 * so without it a goal that legitimately has none would sit in the needs band for
 * ever.
 *
 * ## Azure only
 *
 * Same scope as `filingType` and `ticketAssignee`, and arrived at the same way: a
 * hierarchy parent and a classification node are things only Azure DevOps reports
 * and only Azure DevOps accepts. GitHub issues have neither, so every function
 * here answers "nothing to ask" for them rather than inventing a second notion of
 * a container beside `issueContainerTypes`.
 */

/** Which of the two placements a proposal or a dismissal is about. */
type PlacementField = 'parent' | 'areaPath';

/**
 * The project's classification tree as the harness offers it: every node an item
 * may be filed under, and the root that means *nobody has filed it anywhere*.
 *
 * The root is carried rather than derived from the paths, because deriving it is
 * exactly the guess this type exists to remove — a project whose tree is one node
 * deep has a root indistinguishable from a leaf by string shape alone.
 */
export interface AreaPathTree {
  /** The project root node. An item still on it is unclassified. */
  root: string;
  /**
   * The nodes an item may be moved to — the tree **below** the root, in tree
   * order. Empty for a project that has never subdivided, and then nothing is
   * asked: there is nowhere else to put anything.
   */
  paths: string[];
}

/**
 * How many area nodes the assayer is offered.
 *
 * A cap rather than the whole tree, because a tree long enough to be a directory
 * stops being a choice — the same argument `candidateParents`' own limit makes
 * about a board. Real projects run to a handful of nodes, so this bites almost
 * nowhere; where it does, {@link truncateAreaPaths} says so rather than letting a
 * cut list read as the complete set.
 */
const AREA_PATH_LIMIT = 40;

/**
 * The nodes to offer, and how many were left out.
 *
 * The count is returned rather than dropped so the caller can **say** the list is
 * partial. A silent truncation is the failure worth naming here: an assayer shown
 * thirty of two hundred nodes reads them as the project's areas and picks the
 * least-wrong of them, which is a plausible answer nobody can tell from a right
 * one.
 */
export function truncateAreaPaths(tree: AreaPathTree): { paths: string[]; omitted: number } {
  const paths = tree.paths.slice(0, AREA_PATH_LIMIT);
  return { paths, omitted: Math.max(0, tree.paths.length - paths.length) };
}

/**
 * Whether this item is still missing a given placement — asked of the live work
 * item, never of anything stored.
 *
 * `parent` reads the three states {@link Issue.parent} draws deliberately:
 * `undefined` is a provider that tracks no hierarchy and is never missing
 * anything, `null` is a genuine orphan, and an object is a parent.
 *
 * `areaPath` is the subtler one. An Azure work item is **never** without an area
 * path — an unclassified item sits on the project *root* — so "missing" is
 * equalling the root, and it can only be asked where the root is known. A reader
 * that tested for an empty string would find nothing missing anywhere, on every
 * project, with nothing red.
 */
function isPlacementMissing(issue: Issue, field: PlacementField, tree: AreaPathTree | null): boolean {
  if (field === 'parent') return issue.parent === null;
  if (issue.areaPath === undefined || tree === null) return false;
  return normalizeAreaPath(issue.areaPath) === normalizeAreaPath(tree.root);
}

/**
 * Area paths compare on a normalised form: Azure writes them back with
 * backslashes and echoes whatever separator and casing were sent, so `Contoso\Web`
 * and `contoso/web` are one node addressed two ways. Comparing raw would report
 * every classified item as unclassified on a project whose paths were typed
 * either way — the silent direction.
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
 * The placement questions still open on this goal, in a stable order.
 *
 * Three conditions, all of them cheap and all of them read fresh: the assayer
 * proposed something, the operator has not said it does not apply, and the live
 * item still lacks the field. Order is fixed — parent before area path — because
 * a pair of rows that reorder themselves between two draws is a pair an operator
 * cannot learn.
 *
 * A goal with no assay row, or an assay against text the ticket no longer has,
 * yields nothing: the second is the same reading `isAssayed` takes, so a
 * rewritten ticket stops being asked about until it has been assayed again.
 */
export function placementAsks(
  assay: IssueAssay | null,
  issue: Issue,
  tree: AreaPathTree | null,
  goalRef: string,
): PlacementAsk[] {
  if (!assay || assay.goalRef !== goalRef) return [];
  const asks: PlacementAsk[] = [];
  if (assay.proposedParent !== null && assay.parentSettledAt === null && isPlacementMissing(issue, 'parent', tree))
    asks.push({ field: 'parent', proposedParent: assay.proposedParent, proposedAreaPath: null });
  if (
    assay.proposedAreaPath !== null &&
    assay.areaPathSettledAt === null &&
    isPlacementMissing(issue, 'areaPath', tree)
  )
    asks.push({ field: 'areaPath', proposedParent: null, proposedAreaPath: assay.proposedAreaPath });
  return asks;
}
