import type { HumanTask, Issue, IssueDelivery, IssueShortfall, ValidationCheck } from '../types.js';
import { liveChecks, outstandingChecks } from './verdict.js';

/**
 * The moment validation is actually asked for, said out loud on the bench.
 *
 * A goal parked as delivered with checks nobody has run is the whole failure this
 * exists to end. Until now the only thing that said so was a chip on the goal
 * sheet and a line inside the close-out obligation — both of them surfaces an
 * operator reaches *after* deciding to go and look. The checks were declared by a
 * planner weeks earlier, and the one pulse at which they become runnable — the
 * delivery — announced nothing at all. That is a reminder rather than an
 * obligation, the same shortfall `close_out` was written for one step further on:
 * nothing holds it, nothing settles it, and nothing says on Thursday that nobody
 * ever ran them.
 *
 * A `validate` human task is that obligation, and a human task is the right
 * entity for it by the table in [13](../../docs/spec/13-jobs-and-findings.md): it
 * is a unit of work rather than a question, it outlives the agents that produced
 * the delivery, and it costs nothing while open. **Standalone** — no `part_id` —
 * so it blocks nothing, which keeps the rule that only a plan-declared part ever
 * holds the fleet. Validation gates nothing ([20](../../docs/spec/20-validation.md)),
 * and a row on a list does not start.
 *
 * ## Why this one may settle itself
 *
 * The close-out's asymmetry, argument for argument: the harness cannot observe a
 * console switch being flipped, but it can read the check rows an operator marks
 * off through its own cockpit. Leaving this to a click would ask the operator to
 * tell the harness a thing it already knows, twice — once on the sheet and once
 * on the bench — and the second telling is the one that gets forgotten.
 */

/** What a pass decided, as data — so the decisions are testable without a store. */
type ValidationReadyStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done' | 'declined'; resolution: string };

interface ValidationReadyInput {
  /** The pulse's world issues, for the goal's own name and link. Never a gate — see below. */
  issues: readonly Issue[];
  /** Every standing delivery — the launch that went, and the first moment a check is runnable. */
  deliveries: readonly IssueDelivery[];
  /** Every standing shortfall, so a launch the assessor sent back files nothing. */
  shortfalls: readonly IssueShortfall[];
  /** The `validate` tasks already on these origins, settled ones included. */
  existing: readonly HumanTask[];
  /** Each goal's checks, keyed on its `originRef`. Absent is a goal that declared none. */
  checks: ReadonlyMap<string, readonly ValidationCheck[]>;
  /**
   * The goals an environment gate has opened, or **null when no environment
   * declares one**. Null is not an empty set: it is "nothing gates this", which
   * is every deployment that has not configured a post-merge state.
   *
   * The delivery is when a check becomes *meaningful*; with a gate configured it
   * is not yet when one becomes **runnable** — a check against a build nobody can
   * open is a row asking for work that cannot be done, which is the failure this
   * whole file exists to end, one step earlier.
   * → `docs/spec/24-environments.md#what-an-arrival-means`
   */
  opened: ReadonlySet<string> | null;
}

/**
 * What this pulse owes: the row to file on every delivered goal with checks a
 * person still has to run, and the standing ones the world has settled.
 *
 * Pure, and idempotent by construction — the file arm is emitted on every pulse
 * the goal still owes something, which `recordHumanTask` folds onto the existing
 * row rather than inserting. That repeat is deliberate and it is what keeps the
 * detail honest: the row states which checks are outstanding **now**, not which
 * were outstanding the day it was filed.
 *
 * **A settled row is left alone.** An operator who marked it done or declined it
 * said something about the obligation, and re-filing would quietly rewrite the
 * detail under their verdict — so the file arm is skipped entirely once a row on
 * that origin has stopped being open. The other half of the same rule is that
 * nothing here reopens one: `recordHumanTask` does not reset status, and this
 * does not ask it to.
 */
export function validationReadyPass(input: ValidationReadyInput): ValidationReadyStep[] {
  const byOrigin = new Map(input.existing.map((t) => [t.originRef ?? '', t]));
  const inWorld = new Map(input.issues.map((i) => [`issue:${i.number}`, i]));
  const shortfalls = new Set(input.shortfalls.map((s) => s.originRef));
  const delivered = new Set(input.deliveries.map((d) => d.originRef));
  const steps: ValidationReadyStep[] = [];

  for (const delivery of input.deliveries) {
    const originRef = delivery.originRef;
    // A shortfall and a delivery cannot coexist in the store, so this guards a
    // world that somehow has both — and there the negative wins, as it does
    // everywhere else that asks the pair.
    if (shortfalls.has(originRef)) continue;
    const live = liveChecks(input.checks.get(originRef) ?? []);
    const existing = byOrigin.get(originRef);
    const owed = live.filter(owedToAPerson);

    if (owed.length === 0) {
      // Nothing left for a person: every check is recorded, waived, or sitting
      // with the fleet. A goal that declared no checks at all lands here too and
      // files nothing — nothing was asked for, so nothing is owed.
      if (existing?.status === 'open')
        steps.push({
          kind: 'settle',
          taskId: existing.id,
          status: 'done',
          resolution: settledResolution(live.length),
        });
      continue;
    }
    if (existing && existing.status !== 'open') continue;
    // Held, not dropped. The settle arms above still run, so a check ticked off
    // early still closes a row that was filed before the gate was configured.
    if (input.opened !== null && !input.opened.has(originRef) && !existing) continue;
    steps.push({
      kind: 'file',
      originRef,
      title: validateTitle(originRef),
      detail: validateDetail(inWorld.get(originRef) ?? null, live, owed.length),
    });
  }

  // The retraction. An operator who cleared the delivery row put the goal back
  // into production, and an obligation to validate it then names work that is not
  // finished — the checks will be asked for again, against whatever is delivered
  // next. Declined rather than deleted, the settlement an amended plan already
  // uses on the human part it dropped: the row stays as the record of what was
  // asked, and the note is the account of why it stopped being owed.
  for (const task of input.existing) {
    if (task.status !== 'open' || !task.originRef || delivered.has(task.originRef)) continue;
    steps.push({
      kind: 'settle',
      taskId: task.id,
      status: 'declined',
      resolution: 'the goal went back into production — there is nothing delivered to validate',
    });
  }

  return steps;
}

/**
 * Whether this check is a person's to run.
 *
 * The bench is work only a person can do ([13](../../docs/spec/13-jobs-and-findings.md)),
 * so a check an operator handed to the fleet and which has not come back is not
 * on it: rule `validate-check` is about to dispatch it, and a row asking a person
 * for it is a row that answers itself. Everything else is — including a **failed**
 * one, which is a check somebody has to do something about, and a **deferred**
 * one, which is the quiet exit the verdict already refuses to let deferral be.
 *
 * A hand-back puts it straight back on the bench, and that is the case worth
 * having the field for: the fleet tried, could not, and left the one sentence
 * saying what a person would have to do instead.
 */
function owedToAPerson(check: ValidationCheck): boolean {
  if (check.state === 'passed' || check.state === 'waived') return false;
  return !(check.actor === 'fleet' && check.state === 'unrun' && check.handbackNote === null);
}

/**
 * Stable, and deliberately naming neither the goal's title nor the count of what
 * is outstanding.
 *
 * The title is the merge key `recordHumanTask` folds a repeat onto, so a count in
 * it would file a second row every time a check was ticked off, and a ticket
 * renamed under it would read as a second thing to do. Both belong in the detail,
 * which is rewritten on every pulse.
 */
function validateTitle(originRef: string): string {
  return `Run the validation checks for ${originRef.replace(/^issue:/, 'issue #')}`;
}

/**
 * What is outstanding, in the terms the verdict counts in, refreshed each pulse.
 *
 * Through `outstandingChecks` rather than a list of its own, so this row and the
 * close-out obligation cannot disagree about what a goal owes — and it lists
 * every outstanding check rather than only the ones {@link owedToAPerson} keeps,
 * because a person reading "3 to run" needs to see the fourth that is with the
 * fleet to know it is not missing.
 *
 * The issue is for naming and linking only, and is **never a gate**: a provider
 * whose snapshot failed must not make a standing obligation disappear, and the
 * delivery is the fact this row is filed on.
 */
function validateDetail(issue: Issue | null, live: readonly ValidationCheck[], owed: number): string {
  const name = issue ? `**${issue.title}**` : 'This goal';
  const lines = [
    `${name} is delivered, and its validation plan has ${count(owed, 'check')} for you to run — of ${count(live.length, 'check')} in all.`,
    '',
    ...outstandingChecks(live),
    '',
    'Run them and record each result on the goal, with a note. Nothing is blocked by this: validation gates no dispatch, no merge and no close — what it changes is what closing this goal looks like.',
  ];
  if (issue?.url) lines.push('', issue.url);
  return lines.join('\n');
}

/**
 * Why the row settled itself, in the terms that distinguish the two ways it can:
 * the operator ran everything, or handed the remainder to the fleet. A single
 * "nothing outstanding" would claim the first for the second.
 */
function settledResolution(total: number): string {
  return total === 0
    ? 'the plan no longer asks for any checks'
    : 'every check is recorded, waived, or with the fleet — nothing is left for you to run';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
