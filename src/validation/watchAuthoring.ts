import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import { assessIssueNumber } from '../delivery/assessment.js';
import { hintEmptyReason, watchHintDetail } from '../plans/watchHint.js';
import type { Plan, WatchHint, WatchPlanRecord } from '../types.js';

// → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks

/** Rule `watch-plan`'s dispatch origin: one per goal, `validate-plan`'s shape. Declared in `src/issueOrigins.ts`. */
export function watchPlanOrigin(issueNumber: number): string {
  return issueOriginRef('watchPlan', issueNumber);
}

export function watchPlanBranch(issueNumber: number): string {
  return `watch-plan/issue/${issueNumber}`;
}

/**
 * Which dispatches may write a goal's whole watch, declared in one place so the tool's fence and the
 * rules that brief for it cannot drift: the assessor, in the turn it answers `delivered`, and the
 * catch-up `watch-plan` sends when that turn ended first. `checkSetAuthoringIssue`'s shape.
 */
export function watchAuthoringIssue(originRef: string | null): number | null {
  return issueOriginNumber('watchPlan', originRef) ?? assessIssueNumber(originRef);
}

/**
 * Whether a goal's watch is owed: asked for — a `watch_plans` row, written when the assessor's `delivered`
 * verdict is recorded — and not written yet, or sent back. No record is _never asked_, which is every goal from
 * before the assessor wrote watches and every goal delivered while nothing declared one. The one reading the
 * rule, `assess_issue`, `watch_plan`, the arrival hold and the outcome share.
 * → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks
 */
export function watchOwed(input: { record: WatchPlanRecord | null; planned: boolean }): boolean {
  return input.planned && input.record !== null && input.record.authoredAt === null;
}

/**
 * Whether a `delivered` verdict asks for this goal's watch: a planned goal never asked before and carrying no
 * checks, or one whose watch is owed already. What the assessor's appendix is rendered on and what the verdict
 * writes the owed record on, so the turn is never asked for what the record would not then expect.
 */
export function watchAskedOnDelivery(input: {
  record: WatchPlanRecord | null;
  hasLiveChecks: boolean;
  planned: boolean;
}): boolean {
  return input.record === null ? input.planned && !input.hasLiveChecks : watchOwed(input);
}

/**
 * What the outcome fold is told about a goal with no live checks: why nothing is measured — the authored
 * watch's empty reason, else the plan hint's `none` — or that the watch is still owed. Nothing at all
 * before the goal has landed work, when _nothing measured_ would describe a watch with nothing to measure yet.
 * → docs/spec/29-post-deploy-watch.md#the-outcome
 */
export type WatchStanding = { kind: 'none'; reason: string } | { kind: 'owed' } | null;

export function watchOutcomeStanding(input: {
  plan: Pick<Plan, 'watchHint'> | null;
  record: WatchPlanRecord | null;
  landed: boolean;
}): WatchStanding {
  if (!input.landed) return null;
  const { record } = input;
  if (record?.authoredAt != null)
    return record.emptyReason === null ? null : { kind: 'none', reason: record.emptyReason };
  const hinted = hintEmptyReason(input.plan?.watchHint);
  if (hinted !== null) return { kind: 'none', reason: hinted };
  return watchOwed({ record, planned: input.plan !== null }) ? { kind: 'owed' } : null;
}

/**
 * Why the window pass holds a goal's arrival back, or null where it does not: the watch is **owed**,
 * **proposed** (written, checks in it, not yet accepted), or — for a planned goal not delivered yet and
 * carrying no checks — **undelivered**, since the assessor asks for it only on `delivered` and a fast
 * deployment arrives first. An authored empty watch holds nothing: there is nothing to open a window on.
 * The plan and the delivery are thunks, read only where the record leaves the answer open.
 * → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set
 */
export function watchHold(input: {
  record: WatchPlanRecord | null;
  hasLiveChecks: boolean;
  planned: () => boolean;
  delivered: () => boolean;
}): 'owed' | 'proposed' | 'undelivered' | null {
  const { record } = input;
  if (record?.authoredAt != null) return record.acceptedAt === null && record.emptyReason === null ? 'proposed' : null;
  if (record !== null) return watchOwed({ record, planned: input.planned() }) ? 'owed' : null;
  if (input.hasLiveChecks || input.delivered() || !input.planned()) return null;
  return 'undelivered';
}

/**
 * The assessor's third output, **appended** to the rendered `issue-assess` prompt after the check set's
 * fold and never interpolated, for the reason everything an agent must read is. Rendered only where some
 * environment declares a `watch`, for a goal with a plan whose watch is not authored — the assessor is
 * deciding the verdict, so the record that makes it owed is not written yet.
 */
export function assessWatchNote(): string {
  return `\n\n---\n
## If you answer \`delivered\`, write the post-deploy watch too

The same reading also settles what a running system would have to show, once this ships, for the
work to have done what it claimed. You are standing in the merged code with every part settled — the
only point at which the message template, the operation name and the shape of the fix are all known
and none of them will move.

**Call \`watch_plan\` last**, after \`assess_issue\` and after \`validation_plan\` where that is asked
for. The order is the safety: a turn that ends before it leaves the goal parked with the watch owed,
and rule \`watch-plan\` picks it up on the next pulse. On \`more_work\`, write nothing.

The rest of this section is what the watch is written from.
`;
}

/**
 * Everything a watch author must read: the plan's hint and the operator's words on its tick — as an
 * **input, not an instruction** — the operator's words on a send-back, and the deployment's sources.
 * Appended, never interpolated.
 */
export function watchAuthoringBriefing(input: {
  hint: WatchHint | null;
  tickWords: readonly string[];
  sentBackWords: string | null;
  environments: string;
}): string {
  const lines = ['\n\n---\n', '## What the plan said "worked" would look like\n'];
  if (input.hint === null) {
    lines.push(
      'The plan carried no watch hint. Author the watch from the goal and the merged code alone — and ' +
        'where nothing running behaves differently, declaring nothing with a reason is a complete answer.\n',
    );
  } else {
    lines.push(
      watchHintDetail(input.hint) + '\n',
      '**It is an input, not an instruction.** It was written before any of this code existed. Check what ' +
        'it names where the merged code says it still matters, drop what the code no longer does, add what ' +
        'it could not have known to ask for — and **say so in your `note`**. What is refused is departing ' +
        'silently, never departing. Where one check departs from an intent, say how on that check in ' +
        '`changedFromHint`: the operator sees it marked beside the check.\n',
    );
  }
  const words = input.tickWords.filter((w) => w.trim() !== '');
  if (words.length > 0)
    lines.push(
      'When the operator ticked that hint at approval, they wrote:\n',
      ...words.map((w) => `> ${w.replace(/\n/g, '\n> ')}\n`),
    );
  if (input.sentBackWords !== null)
    lines.push(
      '## Why the last watch was sent back\n',
      `> ${input.sentBackWords.replace(/\n/g, '\n> ')}\n`,
      'Write the watch again with that in hand. What you declare replaces the set that was sent back.\n',
    );
  lines.push(
    '## Declaring the watch\n',
    '`watch_plan` declares the **whole** watch: what you omit is withdrawn, except a check the operator ' +
      'wrote by hand, which is theirs. `note` is required on every call. A call declaring no checks needs ' +
      '`emptyReason` — a refactor, a docs change or a build fix has nothing running to watch, and a ' +
      'check forced onto one could only ever read clean. Every check is put to an environment once as ' +
      'you record it, and anything that comes back unproven is answered to you in the reply, so fix the ' +
      'query and call again in the same turn. Nothing runs on a schedule until the operator accepts the set.\n',
  );
  if (input.environments !== '') lines.push(input.environments);
  return lines.join('\n');
}
