import type { HumanTask, Issue, IssueDelivery, IssueShortfall, ValidationVerdict } from '../types.js';

/**
 * The step after the launch: the ticket is still open, and closing it is work
 * only a person can do.
 *
 * The harness delivers a goal; it does not close the item in the tracker. That is
 * deliberate and settled — issue #234's finding is that a close is *admin work
 * anyone can do at any moment*, so promoting it to the harness's own verdict gets
 * the causality backwards. What was missing is the other half: nothing recorded
 * that the close was still owed. The Signal post said "Update the ticket" and the
 * run carried on regardless, which is a reminder rather than an obligation —
 * nothing holds it, nothing settles it, nothing says on Thursday that it never
 * happened.
 *
 * A `close_out` human task is that obligation, and a human task is the right
 * entity for it by the table in [13](../../docs/spec/13-jobs-and-findings.md): it
 * is a unit of work rather than a question, it outlives the agents that produced
 * the delivery, and it costs nothing while open. Standalone — no `part_id` — so
 * it blocks nothing, which keeps the rule that only a plan-declared part ever
 * holds the fleet.
 *
 * ## Why the harness may settle this one itself
 *
 * Every other human task is settled by a person clicking Done, because the
 * harness has no way to observe a console switch being flipped. This one names a
 * tracker item the harness already refetches every pulse, so leaving it to a
 * click would ask the operator to tell the harness something it can see. That is
 * the whole of what {@link HumanTaskKind} discriminates.
 *
 * **"Closed" is read as "no longer in the open set", two ways**, because the
 * providers disagree about what a closed issue looks like. Azure DevOps keeps
 * reporting the work item with a closed state; GitHub's issues provider fetches
 * open issues only, so a closed one simply stops appearing. Reading only the
 * first would leave every GitHub task open forever; reading only the second would
 * never fire on Azure. Both mean the same thing *about this obligation*: nothing
 * is left for a person to close. The resolution note says which was observed
 * rather than claiming who closed it — a deleted issue and a closed one are
 * indistinguishable here, and both discharge the ask.
 *
 * The gone-arm is skipped entirely on an **empty** issue list. A provider whose
 * snapshot failed returns its last good read, but a first boot against a
 * provider that is down returns nothing at all, and settling every standing
 * obligation off that is the one way this can be wrong at scale.
 */

/** What a pass decided, as data — so the decisions are testable without a store. */
type CloseOutStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done' | 'declined'; resolution: string };

interface CloseOutInput {
  /** The pulse's world issues. Empty means "nothing was read", never "everything closed". */
  issues: readonly Issue[];
  /** Every standing delivery — the launch that went. */
  deliveries: readonly IssueDelivery[];
  /** Every standing shortfall, so a launch the assessor sent back files nothing. */
  shortfalls: readonly IssueShortfall[];
  /** The `close_out` tasks already on these origins, settled ones included. */
  existing: readonly HumanTask[];
  /**
   * Each goal's validation verdict and what it still owes, keyed on the issue
   * origin — absent for a goal with no checks, which is not the same as clear.
   *
   * Carried in rather than looked up, so every decision this file makes stays
   * testable without a store. What it buys is the one moment the flag has to
   * land: the row that says "close this ticket" is exactly where an operator is
   * about to close a goal and move on.
   */
  validation: ReadonlyMap<string, { verdict: ValidationVerdict; outstanding: readonly string[] }>;
}

/**
 * What this pulse owes: the tasks to file, and the standing ones the world has
 * settled. Pure, and idempotent by construction — a pass over a world it has
 * already acted on returns nothing.
 */
export function closeOutPass(input: CloseOutInput): CloseOutStep[] {
  const byOrigin = new Map(input.existing.map((t) => [t.originRef ?? '', t]));
  const inWorld = new Map(input.issues.map((i) => [`issue:${i.number}`, i]));
  const shortfalls = new Set(input.shortfalls.map((s) => s.originRef));
  const delivered = new Set(input.deliveries.map((d) => d.originRef));
  const steps: CloseOutStep[] = [];

  for (const delivery of input.deliveries) {
    const originRef = delivery.originRef;
    if (issueNumber(originRef) === null) continue;
    // A shortfall and a delivery cannot coexist in the store, so this guards a
    // world that somehow has both — and there the negative wins, as it does
    // everywhere else that asks the pair.
    if (shortfalls.has(originRef)) continue;
    const existing = byOrigin.get(originRef);
    const issue = inWorld.get(originRef);

    if (!existing) {
      // Nothing to close: the tracker already stopped listing it open, which is
      // what a GitHub issue a merged "Closes #n" took with it looks like.
      if (!issue || issue.state === 'closed') continue;
      steps.push({
        kind: 'file',
        originRef,
        title: closeOutTitle(issue.number),
        detail: closeOutDetail(issue, delivery, input.validation.get(originRef) ?? null),
      });
      continue;
    }
    if (existing.status !== 'open') continue;
    if (issue?.state === 'closed')
      steps.push({ kind: 'settle', taskId: existing.id, status: 'done', resolution: 'the tracker shows it closed' });
    else if (!issue && input.issues.length > 0)
      steps.push({
        kind: 'settle',
        taskId: existing.id,
        status: 'done',
        resolution: 'the tracker no longer lists it open',
      });
  }

  // The retraction. An operator who cleared the delivery row put the goal back
  // into production, and an open obligation to close its ticket is then pointing
  // at work that is not finished. Declined rather than deleted, the settlement an
  // amended plan already uses on the human part it dropped: the row stays, and the
  // note is the account of why it stopped being owed.
  for (const task of input.existing) {
    if (task.status !== 'open' || !task.originRef || delivered.has(task.originRef)) continue;
    steps.push({
      kind: 'settle',
      taskId: task.id,
      status: 'declined',
      resolution: 'the goal went back into production — there is no delivery to close it out',
    });
  }

  return steps;
}

/**
 * Stable, and deliberately not the issue's own title: this is the row's headline
 * in a list of obligations, so it says what to do, and a ticket renamed under it
 * must not read as a second thing to do.
 */
function closeOutTitle(issueNumber: number): string {
  return `Close issue #${issueNumber} in the tracker`;
}

/**
 * Which tracker, in the only terms that survive a provider swap: the item's own
 * link — and, when the goal's validation plan is not clear, what it still owes.
 *
 * The flag lands here because this is the moment. Everywhere else it is a chip on
 * a screen somebody may not be looking at; this row is put in front of the
 * operator at the point they are about to close the ticket, and the detail is
 * refreshed on every pulse (`recordHumanTask` updates it on a repeat), so it
 * states what is outstanding *now* rather than at the instant the row was filed.
 *
 * **It blocks nothing.** The task can still be marked done, and closing the
 * ticket still settles it. What changes is that doing so is a decision made in
 * front of the count rather than past it.
 */
function closeOutDetail(
  issue: Issue,
  delivery: IssueDelivery,
  validation: { verdict: ValidationVerdict; outstanding: readonly string[] } | null,
): string {
  const by = delivery.by === 'operator' ? 'You' : 'The assessor';
  const lines = [
    `${by} marked **${issue.title}** delivered${delivery.summary ? ` — "${delivery.summary}"` : ''}.`,
    '',
    'The item is still open in the tracker. Close it there and this settles itself on the next pulse — or mark it done here, or decline it and say why.',
  ];
  if (validation && validation.verdict.state === 'flagged') {
    lines.push(
      '',
      `⚠️ **${validationHeadline(validation.verdict)}**`,
      '',
      ...validation.outstanding.map((c) => `- ${c}`),
    );
  }
  if (issue.url) lines.push('', issue.url);
  return lines.join('\n');
}

/**
 * The count, in words, on the terms the verdict counts in: `unrun` and `deferred`
 * are named as outstanding rather than folded into a single "not passed", because
 * the two are the ones an operator is most likely to believe are fine.
 */
export function validationHeadline(verdict: ValidationVerdict): string {
  const parts: string[] = [];
  if (verdict.failed > 0) parts.push(`${verdict.failed} failed`);
  if (verdict.unrun > 0) parts.push(`${verdict.unrun} never run`);
  if (verdict.deferred > 0) parts.push(`${verdict.deferred} deferred`);
  const owed = parts.length > 0 ? parts.join(', ') : 'checks outstanding';
  return `Validation is not clear on this goal — ${owed}, of ${verdict.total}.`;
}

function issueNumber(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}
