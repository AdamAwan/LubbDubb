import { createHash } from 'node:crypto';
import type { Issue, IssueAssay, TaskSummary, WorldEvent } from '../types.js';
import { hasPriorWork } from '../delivery/assessment.js';

/**
 * The goal assay (issue #158): the one gate in front of an issue that asks about
 * its **content** rather than about policy.
 *
 * Everything else standing in front of a fresh ticket — the watch tag, the
 * workflow state, the cooldown, the attempt cap, headroom, `resolvePlanRoute` —
 * asks whether the harness is *allowed* to act. None of them asks whether there is
 * anything to act on. So a vague, self-contradictory or already-obsolete ticket
 * goes straight into the funnel, and the first signal that anything was wrong is
 * an agent spending its attempt cap and ending in a cooldown escalation that reads
 * as the agent's failure. That is `src/ci/ciPolicy.ts`'s failure — work dispatched
 * at a wall it was never going to get through — one stage earlier in the pipeline.
 *
 * The assessor (rule `issue-assess`) is the closest existing thing and asks the same *kind* of
 * question at the opposite end of the run: it judges whether an issue was
 * **delivered**, after the work. This judges whether it was **workable**, before.
 * The two are mutually exclusive by construction — `hasPriorWork` is the
 * discriminator for both, one taking each arm — so no issue is ever a candidate
 * for both in one cycle.
 *
 * ## Block or inform (issue #158's first decision)
 *
 * It blocks, because informing is what the cockpit already does for every other
 * verdict and it would leave the dispatch it exists to prevent happening anyway.
 * What makes blocking safe is that a *missing* verdict holds nothing:
 *
 * - An assayer that crashes, is killed, or spends its attempt cap writes no row,
 *   and the issue falls through to ordinary pickup with no escalation. That is the
 *   planner's fail-open (`resolvePlanRoute`) and the assessor's, arrived at the
 *   same way: narrowing rule `issue-pickup` without it turns any assayer failure into a
 *   permanently parked issue.
 * - Only an explicit `unclear` holds. This is `undeclared`-vs-`more_work` from
 *   `src/issueConclusion.ts` again: the harness acts only on what was actually
 *   said, never on silence, because the failure mode of the other direction is
 *   contingent on model diligence and invisible when it bites.
 * - And the hold itself expires — see {@link assayHold}.
 *
 * ## A third agent in front of the work (the second decision)
 *
 * The cost is worth naming rather than discovering: with planning, assessment and
 * this all unconditional, a single issue can spend three agents before one line of
 * its work is written. What makes it bearable is that only an explicit `unclear`
 * holds anything, and that hold ends on the ticket's own text changing or anyone
 * commenting on it.
 *
 * A pure predicate was considered and is not sufficient: it can check length and
 * structure and nothing else, while every failure this exists to catch — *"this
 * names a module that no longer exists"*, *"this contradicts #98"* — is a judgement
 * about the repository. That is what an agent is for.
 *
 * ## The watch gate (the fifth decision)
 *
 * The assay applies **only** to issues that already pass the watch gate: it never
 * filters an untagged backlog, and it never touches an issue the operator has not
 * asked for. So it does second-guess an explicit operator signal, and it is argued
 * for on that basis: the tag says *work this*, and the assay's answer is not *no*
 * but *with what?* — a question, asked once, that the operator ends by editing the
 * ticket, saying something on it, or clearing the verdict outright. What it must
 * never become is a durable refusal, which is what {@link assayHold} is about.
 */

/**
 * The origin an assaying agent is dispatched on — its own, for `assessOrigin`'s
 * reason: the cooldown and attempt cap that throttle assays must be independent of
 * the pickup attempts on `issue:<n>`, or an issue that burned its pickup budget
 * could never be assayed and a looping assayer would eat the budget that gets the
 * work done.
 */
export function assayOrigin(issueNumber: number): string {
  return `issue:${issueNumber}:assay`;
}

/**
 * The branch an assaying agent works on. Its own namespace beside `plan/issue/<n>`
 * and `assess/issue/<n>` and for the same hard reason: git stores refs as files, so
 * `refs/heads/issue/12` and `refs/heads/issue/12/assay` cannot coexist, and
 * `issue/<n>` is exactly what the pickup agent this rule stands in front of wants.
 *
 * Cut from the **default branch**: the question is whether this goal makes sense
 * against the repository as it stands, so the checkout has to be the repository as
 * it stands.
 */
export function assayBranch(issueNumber: number): string {
  return `assay/issue/${issueNumber}`;
}

/**
 * The fingerprint of the goal text a verdict was cast against.
 *
 * This is the whole of issue #158's fourth decision — *"a ticket edited after a
 * failed assay must be re-assayed, or one bad verdict parks it for good"*. #122's
 * answer to the same problem is expiry on world signal, and that answer is
 * inherited (see {@link assayHold}'s second arm) but it cannot be the only one
 * here: `worldDiff` emits `issue_opened`, `issue_closed` and `issue_linked` and
 * **nothing at all for an edit**, which is precisely the transition that answers
 * the assayer's question. Adding an `issue_edited` event would make the verdict
 * depend on the harness having witnessed the moment of the edit — the fragility
 * `deliveryHold` refused for the same reason, and worse here, because a ticket
 * rewritten while the harness was down would stay parked forever.
 *
 * Fingerprinting the text instead makes the check a **lookup against current
 * state**: it survives a restart, a lost baseline and a missed pulse, and it is
 * exact rather than approximate — an assay is a verdict about a text, so the thing
 * that ends it is that text being different.
 *
 * Title and body both, joined by NUL — a byte neither field can contain — so moving
 * words from one to the other still fingerprints differently rather than colliding
 * with the concatenation. Truncated to 16 hex chars: this is a change detector between two
 * readings of one ticket, not a security boundary.
 */
export function goalFingerprint(title: string | null, body: string | null): string {
  return createHash('sha256')
    .update(`${title ?? ''}\u0000${body ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** What a hold is judged against: the ticket in front of us, and the world since the verdict. */
interface AssayHoldContext {
  /**
   * World transitions covering at least {@link assaySignalQuery}'s window. Absent =
   * nothing observed, so every verdict still stands — the direction that holds
   * rather than acts, which is the one to take when a caller has not wired the read.
   */
  signals?: WorldEvent[];
}

/**
 * The world item an assay verdict is about. Not exported, for `proposalWorldRef`'s
 * reason: it is used both to *match* events and to *ask* for them, and those two
 * answering differently is the bug class this repo has fixed twice.
 */
function assayWorldRef(originRef: string): string | null {
  return /^issue:\d+$/.test(originRef) ? originRef : null;
}

/**
 * Why this issue is held out of the funnel by a standing assay, or null when it is
 * free. The string is operator-facing — the cockpit chip and the dispatcher's skip
 * reason both render it.
 *
 * ## What ends a hold
 *
 * Three things, and **no timer**, which is #122's asymmetry preserved: an accepted
 * act waits on the world to *reflect* something done, which is a duration; a
 * refused goal waits on it to *become* something else, which is an event. A verdict
 * that expired on a clock would re-ask a question whose answer has not changed —
 * "not this second" under a longer name — and, since the assayer costs an agent,
 * it would re-ask it forever at a fixed price.
 *
 * 1. **The goal text changed** ({@link goalFingerprint}). The direct answer: the
 *    verdict describes a ticket that no longer exists. This is the arm that makes
 *    the loop closable — an operator reads what the assay could not work out,
 *    edits the ticket, and it is re-assayed on the next pulse with no clearing
 *    step and nothing to remember.
 * 2. **Any transition on the issue since the verdict**, which is #109 phase 4's
 *    rejection expiry transferred whole. **Any**, not a filtered subset, for
 *    `expiringSignal`'s reason: a per-kind filter here is a second opinion about
 *    which changes matter, sitting nowhere near the rule it second-guesses. In
 *    practice the one that lands is a reopen or a link — and, importantly, this is
 *    the arm that covers a human who answers the assay's question in a **comment**
 *    rather than by editing the body.
 * 3. **The operator deleting the row**, which is why it is not an arm:
 *    `Store.clearAssay` removes it, so "not assayed" keeps exactly one
 *    representation — the same reason clearing a conclusion is a delete.
 *
 * Expiry lifts the hold; it does not retract the verdict. On a re-assay the row is
 * overwritten, so what the operator reads is always the latest thing said.
 *
 * ## The second arm: an unanswered profile proposal (issue #342)
 *
 * The assayer also proposes which model profile this goal's work should run on,
 * and a proposal that differs from what is already standing holds the funnel
 * until a human answers it. Blocking rather than informing, for the same reason
 * the `unclear` arm blocks: informing is what the cockpit already does for every
 * verdict, and the dispatch the gate exists to price correctly would happen
 * anyway. What makes it safe is what makes the first arm safe — **an absent
 * proposal holds nothing**, so an assayer that crashes, is killed, spends its
 * attempt cap, or simply names no profile leaves the issue to the funnel it
 * would have entered anyway, on its rule's own entry.
 *
 * Agreement holds nothing either, and costs no click: the divergence is decided
 * once, where the proposal is written and the tag and config are both in hand,
 * and a proposal that matched what was standing is stored already answered. So
 * the question this arm asks is a two-field read, with no config threaded into
 * it and no caller able to forget a lookup and gate the whole fleet by accident.
 *
 * Unlike the first arm it does **not** expire on world signal. A comment or a
 * link is how a human answers "I could not act on this goal"; it is not how they
 * authorise spending more money than the rule allows, and treating it as one
 * would release the gate without anyone deciding anything. Three things end it:
 * the operator answering, the ticket being rewritten (a new fingerprint, so a
 * re-assay proposes against the current text), and the row being cleared.
 */
export function assayHold(assay: IssueAssay | null, issue: Issue, ctx: AssayHoldContext = {}): string | null {
  if (!assay) return null;
  // The ticket was rewritten: whatever the assayer read, it is not this. Applies
  // to both arms — a proposal is a judgement about a text too.
  if (assay.goalRef !== goalFingerprint(issue.title, issue.body)) return null;

  if (assay.verdict === 'unclear' && !expiringSignal(assay, ctx.signals ?? [])) return unclearHold(assay);
  // Asked after the refusal, so an issue that is both refused and unpriced reads
  // as refused: there is no point pricing work that is not going to start.
  if (assay.proposedProfile !== null && assay.profileAnsweredAt === null)
    return `the goal assay proposes running this on "${assay.proposedProfile}"`;
  return null;
}

function unclearHold(assay: IssueAssay): string {
  const by = assay.by === 'operator' ? 'you' : 'the goal assay';
  // The verdict's own words and the time it was reached are **not** in here, and
  // deliberately: this is one reason among several on a row that already carries
  // `IssueAssay` in full, so a caller that wants the quote reads it there. Folding
  // them in made the single longest string the cockpit renders — a paragraph and a
  // raw ISO timestamp in a chip built to be scanned — which is the opposite of what
  // a reason is for. Nothing is lost: the panel puts the summary and a relative
  // time in the chip's title, and the ticket comment has the whole of it.
  return `${by} could not act on this goal`;
}

/** The transition that ended a verdict's standing, or null while it still stands. */
function expiringSignal(assay: IssueAssay, signals: WorldEvent[]): WorldEvent | null {
  const item = assayWorldRef(assay.originRef);
  if (!item) return null;
  return signals.find((e) => e.ref === item && e.createdAt > assay.decidedAt) ?? null;
}

/**
 * Which world events {@link assayHold} needs, as a query — the items to look at and
 * how far back.
 *
 * Bounded by *time and item* rather than by row count, mirroring
 * `deliverySignalQuery`/`rejectionSignalQuery` and for their reason: `listAssays`
 * is unbounded, so a count-bounded event read would judge an old verdict against
 * events it cannot see and hold it forever.
 *
 * Narrowed to the **`unclear`** rows, because they are the only arm of
 * {@link assayHold} that reads signal at all: an unanswered profile proposal is
 * ended by the operator answering it, never by a transition on the ticket, so
 * widening this would fetch events nothing consults. Null when none is standing,
 * which is every deployment until an issue is refused: no query, no read.
 */
export function assaySignalQuery(assays: IssueAssay[]): { since: string; refs: string[] } | null {
  const refs = new Set<string>();
  let since: string | null = null;
  for (const a of assays) {
    if (a.verdict !== 'unclear') continue;
    const item = assayWorldRef(a.originRef);
    if (!item) continue;
    refs.add(item);
    if (since === null || a.decidedAt < since) since = a.decidedAt;
  }
  return since !== null && refs.size > 0 ? { since, refs: [...refs] } : null;
}

/**
 * Has work on this issue actually started — i.e. is the goal still the only thing
 * there is to judge?
 *
 * Exactly `hasPriorWork`, and that is the point rather than an accident. This began
 * as `hasPriorWork` with the assay's **own** tasks filtered out, because
 * `issue:<n>:assay` was inside the `issue:<n>:*` subtree that predicate matched: an
 * assayer that crashed without writing a verdict would count as prior work and no
 * second attempt could ever be made, silently retiring the cooldown, the attempt cap
 * and the assessor's arm of the same discriminator. The exclusion was right and its
 * scope was wrong — an assay is the harness *asking* rather than the work being
 * done, and so is a plan, which nothing excluded until `issue:<n>:plan` parked every
 * `single`-routed issue in the assessor. `issueOriginRole` now makes the distinction
 * for both, so this is a name for the question rather than a second answer to it.
 *
 * The assessor's and the retrospective's origins are still counted: both only ever
 * fire downstream of work, so either is evidence that some was done.
 */
export function hasWorkStarted(issueNumber: number, tasks: TaskSummary[]): boolean {
  return hasPriorWork(issueNumber, tasks);
}

/**
 * Whether this issue already carries a verdict about the text it currently has —
 * i.e. whether there is anything left to assay.
 *
 * Asked instead of "is there a row", so an edited ticket is re-assayed on its own:
 * the same fingerprint comparison that ends a hold is what re-opens the question,
 * which is what keeps the rule and the gate from disagreeing about whether an issue
 * has been judged.
 */
export function isAssayed(assay: IssueAssay | null, issue: Issue): boolean {
  return assay !== null && assay.goalRef === goalFingerprint(issue.title, issue.body);
}
