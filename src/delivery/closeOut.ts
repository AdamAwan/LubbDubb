import { DELIVERY_AUTHOR } from './delivery.js';
import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
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
 * entity for it by the table in [13](../../docs/spec/13-jobs-and-tickets.md): it
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
  | { kind: 'settle'; taskId: string; status: 'done' | 'declined'; resolution: string }
  | { kind: 'reopen'; taskId: string; detail: string };

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
  /**
   * The goals an environment gate has opened, or **null when no environment
   * declares one** — which is every deployment that has not configured a
   * post-merge state, and is why this is not a plain set.
   *
   * With a gate configured, a delivery is no longer the moment: the ticket is
   * closed once the work is somewhere a person can check it, and asking for the
   * close before then is asking for a decision nobody can make yet. Folding null
   * into an empty set would withhold this obligation on every deployment on
   * earth, and would look exactly like the feature working.
   * → `docs/spec/24-environments.md#what-an-arrival-means`
   */
  opened: ReadonlySet<string> | null;
  /**
   * The goals whose `validate` row is still open — the checks a person has not
   * finished with.
   *
   * **The bench asks for one thing at a time.** Filed together, the two rows say
   * "run these checks" and "close this ticket" in the same breath, and the second
   * is an invitation to skip the first: whoever is looking has the close in front
   * of them and no reason to believe the order matters. So the close is not asked
   * for until validation has had its turn — settled by the results coming in, or
   * settled by hand, which is the escape for a check that failed or will never be
   * run.
   *
   * Read from the bench rather than from the verdict deliberately. A `flagged`
   * verdict would hold the close for good on a goal with one failing check, and
   * the operator's way of saying "I am done with this" is the row, not the checks.
   */
  validating: ReadonlySet<string>;
  /**
   * What each goal's post-deploy watch says, in one sentence, keyed on the issue
   * origin — absent for a goal nothing is watching.
   *
   * **Carried, never acted on.** A watch holds nothing by default: it reports, and
   * this row carries what it reports at the moment an operator is about to close
   * the ticket. That is `validate`'s arrangement exactly — a close-out settled
   * early is settled *in front of* the reading rather than past it — and the
   * detail being rewritten on every pulse is what keeps the sentence the one the
   * watch is saying now. → `docs/spec/29-post-deploy-watch.md#it-holds-nothing-unless-asked`
   */
  watch: ReadonlyMap<string, string>;
  /**
   * The goals a `watch.holds: ["close_out"]` opt-in has cleared — those whose
   * window on a declaring environment has **settled** — or **null where no
   * environment declares one**, which is every deployment, since `holds` is off.
   *
   * {@link opened}'s shape, and nullable for its reason: an empty set would
   * withhold this obligation everywhere and would look exactly like the feature
   * working. A settled window rather than an open one is what clears it, because
   * this row is filed on the *delivery* — days before the work arrives anywhere —
   * so a hold that waited only on open windows would never withhold a thing.
   */
  watchCleared: ReadonlySet<string> | null;
  /**
   * Whether this deployment's tracker can be closed from the cockpit — the
   * connector's own answer, not a guess from the provider's name.
   *
   * It changes one thing: the sentence the row offers as the way to discharge it.
   * A deployment whose issues provider cannot close (there is no button on the row
   * either) must not be told to press one, and a deployment that can must not be
   * sent to the tracker to do by hand what the row will do for it — both are the
   * row stating the wrong way out, which is the whole of what it is for.
   */
  canClose: boolean;
}

/**
 * What this pulse owes: the tasks to file, and the standing ones the world has
 * settled. Pure, and idempotent through `recordHumanTask`'s dedup rather than by
 * silence — an owed row is re-filed on every pulse, exactly as
 * {@link validationReadyPass} does it, so the detail states what is outstanding
 * *now*. Only a settled row is skipped.
 */
export function closeOutPass(input: CloseOutInput): CloseOutStep[] {
  const byOrigin = new Map(input.existing.map((t) => [t.originRef ?? '', t]));
  const inWorld = new Map(input.issues.map((i) => [`issue:${i.number}`, i]));
  const shortfalls = new Set(input.shortfalls.map((s) => s.originRef));
  const delivered = new Set(input.deliveries.map((d) => d.originRef));
  const steps: CloseOutStep[] = [];

  for (const delivery of input.deliveries) {
    const originRef = delivery.originRef;
    if (closeOutIssueNumber(originRef) === null) continue;
    // A shortfall and a delivery cannot coexist in the store, so this guards a
    // world that somehow has both — and there the negative wins, as it does
    // everywhere else that asks the pair.
    if (shortfalls.has(originRef)) continue;
    const existing = byOrigin.get(originRef);
    const issue = inWorld.get(originRef);

    // Answered. A settled row is never re-filed and never re-settled — the whole
    // point of an answer is that it is the last thing said about the row. Scoped
    // to an *operator's* answer: a row the harness retracted below said only that
    // the obligation was not owed while the goal was back in production, and it is
    // owed again now that the goal is delivered again. Reopened rather than
    // re-filed, because `recordHumanTask`'s dedup ignores status and would refresh
    // the declined row's detail and leave it declined.
    if (existing && existing.status !== 'open') {
      if (deskSettled(existing) && issue && issue.state !== 'closed')
        steps.push({
          kind: 'reopen',
          taskId: existing.id,
          detail: closeOutDetail(
            issue,
            delivery,
            input.validation.get(originRef) ?? null,
            input.canClose,
            input.watch.get(originRef) ?? null,
          ),
        });
      continue;
    }

    // Nothing to close: the tracker already stopped listing it open, which is
    // what a GitHub issue a merged "Closes #n" took with it looks like. A row
    // already standing over it discharges.
    if (issue?.state === 'closed') {
      if (existing)
        steps.push({ kind: 'settle', taskId: existing.id, status: 'done', resolution: 'the tracker shows it closed' });
      continue;
    }
    if (!issue) {
      // An empty `issues` is a world nobody read — a provider outage, the first
      // pulse — not a tracker that dropped the item, so it settles nothing.
      if (existing && input.issues.length > 0)
        steps.push({
          kind: 'settle',
          taskId: existing.id,
          status: 'done',
          resolution: 'the tracker no longer lists it open',
        });
      continue;
    }

    // Both gates hold a **new** row only. The goal is delivered and its ticket
    // is open, but the work has not reached the environment whose arrival opens
    // this, or validation is still somebody's and the close is the step after
    // it. Once a row stands, neither un-files it: the settle arms above run
    // regardless, so a ticket closed by hand in the meantime still discharges.
    if (!existing) {
      if (input.opened !== null && !input.opened.has(originRef)) continue;
      if (input.validating.has(originRef)) continue;
      // And the opt-in a team asks for when it wants the stricter thing: an
      // environment declaring `holds: ["close_out"]` withholds the row until its
      // watch on this goal has settled. A **new** row only, like both gates above.
      if (input.watchCleared !== null && !input.watchCleared.has(originRef)) continue;
    }

    // Filed every pulse a row is owed, standing or not. `recordHumanTask` folds
    // the repeat onto the row it already keyed and rewrites `detail`, which is
    // the only thing that keeps the validation flag below current — a row filed
    // while the plan was clear and flagged an hour later would otherwise state,
    // at the moment an operator closes the ticket, that nothing is outstanding.
    steps.push({
      kind: 'file',
      originRef,
      title: closeOutTitle(issue.number),
      detail: closeOutDetail(
        issue,
        delivery,
        input.validation.get(originRef) ?? null,
        input.canClose,
        input.watch.get(originRef) ?? null,
      ),
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
      resolution: DESK_SETTLED + 'the goal went back into production — there is no delivery to close it out',
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
  canClose: boolean,
  watch: string | null,
): string {
  // Capitalised here rather than held as a second record: the words are the same
  // words `deliveryHold` uses, and two records is how the two sentences come to
  // name one verdict's author differently.
  const author = DELIVERY_AUTHOR[delivery.by];
  const by = author.charAt(0).toUpperCase() + author.slice(1);
  const lines = [
    `${by} marked **${issue.title}** delivered${delivery.summary ? ` — "${delivery.summary}"` : ''}.`,
    '',
    canClose
      ? 'The item is still open in the tracker. **Close the ticket** here does it and settles this row with it — or close it in the tracker yourself and this settles itself on the next pulse, or mark it done here, or decline it and say why.'
      : 'The item is still open in the tracker. Close it there and this settles itself on the next pulse — or mark it done here, or decline it and say why.',
  ];
  if (validation && validation.verdict.state === 'flagged') {
    lines.push(
      '',
      `⚠️ **${validationHeadline(validation.verdict)}**`,
      '',
      ...validation.outstanding.map((c) => `- ${c}`),
    );
  }
  // What the running system has said since the work arrived, and nothing more:
  // this row is closable whatever it says. A hold would be the stricter thing an
  // environment opts into, above, and it is off.
  if (watch !== null) lines.push('', watch);
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

/**
 * The tracker item a close-out row names, or null for an origin that is not an
 * issue at all.
 *
 * Exported because the row's own **Close the ticket** button
 * (`POST /api/human-tasks/:id/close-ticket`) has to resolve the same number this
 * pass files against, and two readings of one origin string is how the button
 * comes to close a different item from the one the row is about.
 */
export function closeOutIssueNumber(originRef: string | null): number | null {
  if (originRef === null) return null;
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}
