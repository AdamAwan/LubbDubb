import type { Issue, IssueAppraisal } from '../types.js';
import { isOrphanIssue } from '../issueRelations.js';

/**
 * Where a goal sits on the backlog — its **parent** and its **area path** — and
 * whether the appraisal's proposal for either is still worth putting to a human.
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
 * and is fixable at any point afterwards. So {@link appraisalHold} is not touched and
 * neither is `goalFingerprint` — this is read only where it is drawn.
 *
 * ## Derived visibility, not stored expiry
 *
 * The question is asked while the **live** work item still lacks the field, and
 * that is the whole of its lifetime. An operator who sets the parent by hand in
 * the tracker ends the question on the next world read: no timer, no world event
 * to have missed, and nothing to remember. This is `appraisalHold`'s fingerprint arm
 * pointed at a different fact — the state of the item rather than of its text —
 * and it is a lookup against current state for the same reason.
 *
 * The one thing that *is* stored is the operator's answer
 * ({@link IssueAppraisal.parentSettledAt}), which exists for the third of the three:
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
export type PlacementField = 'parent' | 'areaPath';

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
 * How many area nodes the appraiser is offered.
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
 * partial. A silent truncation is the failure worth naming here: an appraiser shown
 * thirty of two hundred nodes reads them as the project's areas and picks the
 * least-wrong of them, which is a plausible answer nobody can tell from a right
 * one.
 */
export function truncateAreaPaths(tree: AreaPathTree): { paths: string[]; omitted: number } {
  const paths = tree.paths.slice(0, AREA_PATH_LIMIT);
  return { paths, omitted: Math.max(0, tree.paths.length - paths.length) };
}

/**
 * Whether this item is still unclassified — asked of the live work item, never of
 * anything stored.
 *
 * An Azure work item is **never** without an area path: an unclassified item sits
 * on the project *root*, so "missing" is equalling the root, and it can only be
 * asked where the root is known. A reader that tested for an empty string would
 * find nothing missing anywhere, on every project, with nothing red.
 *
 * The parent's half of this question is {@link isOrphanIssue}, which is a
 * different shape and deliberately not folded in here: it reads the three states
 * {@link Issue.parent} draws (`undefined` is a provider that tracks no hierarchy,
 * `null` is a genuine orphan, an object is a parent) *and* the operator's type
 * policy, so the note an appraiser reads and the question the cockpit asks are
 * one predicate rather than two that agree by coincidence.
 */
function isAreaPathMissing(issue: Issue, tree: AreaPathTree | null): boolean {
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
 * Order is fixed — parent before area path — because a pair of rows that reorder
 * themselves between two draws is a pair an operator cannot learn. Everything is
 * read fresh: nothing here is stored except the operator's own answer.
 *
 * ## The two arms are asked differently, and that asymmetry is the point
 *
 * **The parent question is the fact.** It is asked because the live work item
 * hangs off nothing — whoever did or did not suggest what to do about it. It used
 * to require the appraiser to have *proposed* a container, and that made the
 * commonest reading of the board silent: the candidate containers reach an
 * appraiser only through `relatedWorkNote`, off a world list narrowed by tag and
 * assignee, so a project whose open Features are simply not in that narrowed list
 * offers the appraiser nothing to name, it names nothing, and no question is ever
 * asked. Nothing is red, and an orphan nobody was asked about looks exactly like
 * an item that is properly filed. The proposal, where there is one, is what the
 * question *offers* — never what makes it appear. Same reading `orphanGoal`
 * (`web/src/view/orphanGoal.ts`) already took on the goal page.
 *
 * **The area path question is the proposal**, and stays that way. There is no
 * equivalent gap: the project's tree is read whole through `AreaPathDirectory`
 * and handed to the appraiser as a closed enum on the tool itself, so an
 * appraiser that can answer at all is always in a position to. A node it did not
 * pick is a node the harness has no opinion about, and a row offering an
 * operator the whole tree with no first choice is a directory rather than a
 * question.
 *
 * ## What ends each
 *
 * The parent's is {@link isOrphanIssue} going false — the operator set it by hand
 * in the tracker, and the next world read is the whole of the expiry. The area
 * path's is the item leaving the project root. Neither needs a timer, and neither
 * has a world event to have missed. `parentSettledAt` / `areaPathSettledAt` are
 * the third answer, for the case that changes nothing out there to find.
 *
 * An appraisal against text the ticket no longer has counts as **no appraisal**:
 * that is the same reading `isAppraised` takes, so a rewritten ticket asks again
 * rather than standing on an answer given about something else. For the parent
 * that means the question comes back with nothing offered; for the area path it
 * means nothing is asked until the goal has been appraised again.
 */
export function placementAsks(
  appraisal: IssueAppraisal | null,
  issue: Issue,
  tree: AreaPathTree | null,
  goalRef: string,
  types: PlacementTypePolicy = {},
): PlacementAsk[] {
  // An appraisal fingerprinted against text the ticket no longer carries says
  // nothing about the ticket as it stands — including whether its parent question
  // was answered, which is scoped to `goal_ref` for exactly that reason.
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
 * The operator's two type policies, as the parent question reads them.
 *
 * Carried as one argument rather than two loose lists so a caller cannot supply
 * half of it: {@link isOrphanIssue} answers false for a container *and* for a type
 * nobody parents, and a snapshot that passed only `containerTypes` would silently
 * fall back to the built-in `DEFAULT_PARENTED_TYPES` on exactly the deployments
 * that configured their own.
 */
export interface PlacementTypePolicy {
  /** `issueContainerTypes` — the types that hold work rather than being work. */
  containerTypes?: readonly string[];
  /** `issueParentedTypes` — the types expected to hang off one of the above. */
  parentedTypes?: readonly string[];
}
