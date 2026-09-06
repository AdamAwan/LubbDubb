import { createHash } from 'node:crypto';
import type { Issue, IssueAppraisal, TaskSummary, WorldEvent } from '../types.js';
import { hasPriorWork } from '../delivery/assessment.js';

/**
 * The goal appraisal: the gate in front of an issue asking about its **content**
 * rather than policy — is there anything to act on? Silence holds nothing: only
 * an explicit `unclear` gates, so a crashed, killed or capped appraiser leaves
 * the issue to ordinary pickup. → `docs/spec/06-issue-pickup.md#the-goal-appraisal-unclear`
 */

/** The origin an appraising agent is dispatched on — its own, so its cooldown and attempt cap stay independent of pickup on `issue:<n>`. */
export function appraisalOrigin(issueNumber: number): string {
  return `issue:${issueNumber}:appraisal`;
}

/** The branch an appraising agent works on — its own namespace, since git refs are files and `issue/12` and `issue/12/appraisal` cannot coexist. Cut from the default branch. */
export function appraisalBranch(issueNumber: number): string {
  return `appraisal/issue/${issueNumber}`;
}

/**
 * The fingerprint of the goal text a verdict was cast against — a lookup against
 * current state, not an event, so a ticket rewritten while the harness was down
 * is still re-appraised. Title and body joined by NUL; 16 hex chars, a change
 * detector, not a security boundary.
 */
export function goalFingerprint(title: string | null, body: string | null): string {
  return createHash('sha256')
    .update(`${title ?? ''}\u0000${body ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** What a hold is judged against: the ticket in front of us, and the world since the verdict. */
interface AppraisalHoldContext {
  /** World transitions covering at least {@link appraisalSignalQuery}'s window. Absent = nothing observed, every verdict still stands. */
  signals?: WorldEvent[];
}

/** The world item an appraisal verdict is about. One function, since it both matches events and asks for them — those two answering differently is a known bug class. */
function appraisalWorldRef(originRef: string): string | null {
  return /^issue:\d+$/.test(originRef) ? originRef : null;
}

/**
 * Why this issue is held out of the funnel by a standing appraisal, or null when
 * free. Operator-facing — the cockpit chip and dispatcher skip reason both render
 * it. An `unclear` verdict ends on the goal text changing, any transition since
 * the verdict, or the row being deleted — never on a timer. An unanswered profile
 * proposal ends only on the operator answering, a rewrite, or a clear.
 * → `docs/spec/06-issue-pickup.md#the-goal-appraisal-unclear`
 */
export function appraisalHold(
  appraisal: IssueAppraisal | null,
  issue: Issue,
  ctx: AppraisalHoldContext = {},
): string | null {
  if (!appraisal) return null;
  // The ticket was rewritten: whatever the appraiser read, it is not this. Both arms.
  if (appraisal.goalRef !== goalFingerprint(issue.title, issue.body)) return null;

  if (appraisal.verdict === 'unclear' && !expiringSignal(appraisal, ctx.signals ?? [])) return unclearHold(appraisal);
  // After the refusal, so an issue both refused and unpriced reads as refused.
  if (appraisal.proposedProfile !== null && appraisal.profileAnsweredAt === null)
    return `the goal appraisal proposes running this on "${appraisal.proposedProfile}"`;
  return null;
}

function unclearHold(appraisal: IssueAppraisal): string {
  const by = appraisal.by === 'operator' ? 'you' : 'the goal appraisal';
  // Deliberately no quote and no timestamp: a caller that wants either reads
  // `IssueAppraisal` in full. This is a chip built to be scanned.
  return `${by} could not act on this goal`;
}

/** The transition that ended a verdict's standing, or null while it still stands. Measured against {@link verdictCast}, never `decided_at`, which dates the first verdict. */
function expiringSignal(appraisal: IssueAppraisal, signals: WorldEvent[]): WorldEvent | null {
  const item = appraisalWorldRef(appraisal.originRef);
  if (!item) return null;
  const cast = verdictCast(appraisal);
  return signals.find((e) => e.ref === item && e.createdAt > cast) ?? null;
}

/** When the verdict standing *now* was cast. `decided_at` survives an overwrite (dates the first judgement); `updated_at` moves with the re-cast. */
function verdictCast(appraisal: IssueAppraisal): string {
  return appraisal.updatedAt ?? appraisal.decidedAt;
}

/**
 * Which world events {@link appraisalHold} needs, as a query. Bounded by time and
 * item rather than row count — a count-bounded read would judge an old verdict
 * against events it cannot see and hold it forever. Narrowed to `unclear` rows;
 * null when none is standing.
 */
export function appraisalSignalQuery(appraisals: IssueAppraisal[]): { since: string; refs: string[] } | null {
  const refs = new Set<string>();
  let since: string | null = null;
  for (const a of appraisals) {
    if (a.verdict !== 'unclear') continue;
    const item = appraisalWorldRef(a.originRef);
    if (!item) continue;
    refs.add(item);
    // The instant the predicate compares against, so a re-cast shrinks the window.
    const cast = verdictCast(a);
    if (since === null || cast < since) since = cast;
  }
  return since !== null && refs.size > 0 ? { since, refs: [...refs] } : null;
}

/** Has work on this issue actually started? Exactly `hasPriorWork` — a name for the question, not a second answer to it. */
export function hasWorkStarted(issueNumber: number, tasks: TaskSummary[]): boolean {
  return hasPriorWork(issueNumber, tasks);
}

/** Whether this issue already carries a verdict about its current text. Asked instead of "is there a row" so an edited ticket is re-appraised on its own. */
export function isAppraised(appraisal: IssueAppraisal | null, issue: Issue): boolean {
  return appraisal !== null && appraisal.goalRef === goalFingerprint(issue.title, issue.body);
}
