import { DELIVERY_AUTHOR } from './delivery.js';
import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { HumanTask, Issue, IssueDelivery, IssueShortfall, ValidationVerdict } from '../types.js';

/**
 * The step after the launch: the harness delivers a goal but does not close the tracker
 * item, so a `close_out` human task records that the close is still owed. Standalone — no
 * `part_id` — so it blocks nothing. The gone-arm is skipped on an **empty** issue list — a
 * world nobody read must not settle every standing obligation. → [13](../../docs/spec/13-jobs-and-tickets.md)
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
   * Each goal's validation verdict and what it still owes, keyed on the issue origin —
   * absent for a goal with no checks, which is not the same as clear.
   */
  validation: ReadonlyMap<string, { verdict: ValidationVerdict; outstanding: readonly string[] }>;
  /**
   * The goals an environment gate has opened, or **null when no environment declares one**.
   * Never fold null into an empty set: that withholds this obligation on every deployment
   * and looks exactly like the feature working. →
   * `docs/spec/24-environments.md#what-an-arrival-means`
   */
  opened: ReadonlySet<string> | null;
  /**
   * The goals whose `validate` row is still open — the checks a person has not finished
   * with.
   */
  validating: ReadonlySet<string>;
  /**
   * What each goal's post-deploy watch says, in one sentence, keyed on the issue origin —
   * absent for a goal nothing is watching. **Carried, never acted on**; the detail is
   * rewritten every pulse so the sentence stays current. →
   * `docs/spec/29-post-deploy-watch.md#it-holds-nothing-unless-asked`
   */
  watch: ReadonlyMap<string, string>;
  /**
   * The goals a `watch.holds: ["close_out"]` opt-in has cleared — those whose window on a
   * declaring environment has **settled** — or **null where no environment declares one**.
   */
  watchCleared: ReadonlySet<string> | null;
  /**
   * Whether this deployment's tracker can be closed from the cockpit — the connector's own
   * answer, not a guess from the provider's name.
   */
  canClose: boolean;
}

/** What this pulse owes: the tasks to file, and the standing ones the world has settled. */
export function closeOutPass(input: CloseOutInput): CloseOutStep[] {
  const byOrigin = new Map(input.existing.map((t) => [t.originRef ?? '', t]));
  const inWorld = new Map(input.issues.map((i) => [`issue:${i.number}`, i]));
  const shortfalls = new Set(input.shortfalls.map((s) => s.originRef));
  const delivered = new Set(input.deliveries.map((d) => d.originRef));
  const steps: CloseOutStep[] = [];

  for (const delivery of input.deliveries) {
    const originRef = delivery.originRef;
    if (closeOutIssueNumber(originRef) === null) continue;
    // A shortfall and a delivery cannot coexist in the store; where both somehow
    // appear the negative wins, as everywhere else that asks the pair.
    if (shortfalls.has(originRef)) continue;
    const existing = byOrigin.get(originRef);
    const issue = inWorld.get(originRef);

    // Answered: an operator's settled row is never re-filed or re-settled. One the
    // harness retracted is owed again now the goal is delivered again — reopened
    // rather than re-filed, since the dedup ignores status and would leave it declined.
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

    // Nothing to close: the tracker already stopped listing it open. A row already
    // standing over it discharges.
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

    // Both gates hold a **new** row only — once a row stands neither un-files it,
    // so a ticket closed by hand in the meantime still discharges above.
    if (!existing) {
      if (input.opened !== null && !input.opened.has(originRef)) continue;
      if (input.validating.has(originRef)) continue;
      // The stricter opt-in: `holds: ["close_out"]` withholds the row until the
      // watch on this goal has settled. A **new** row only, like both gates above.
      if (input.watchCleared !== null && !input.watchCleared.has(originRef)) continue;
    }

    // Filed every pulse a row is owed: `recordHumanTask` folds the repeat onto the
    // keyed row and rewrites `detail`, which is what keeps the validation flag current.
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

  // The retraction: with the delivery row cleared, the goal is back in production
  // and the close is no longer owed. Declined rather than deleted, so the row stays
  // with the account of why.
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
 * Stable, and deliberately not the issue's own title: a ticket renamed under the row must
 * not read as a second thing to do.
 */
function closeOutTitle(issueNumber: number): string {
  return `Close issue #${issueNumber} in the tracker`;
}

/**
 * Which tracker, in the only terms that survive a provider swap: the item's own link — and,
 * when the goal's validation plan is not clear, what it still owes. **It blocks nothing** —
 * the row is still closable either way.
 */
function closeOutDetail(
  issue: Issue,
  delivery: IssueDelivery,
  validation: { verdict: ValidationVerdict; outstanding: readonly string[] } | null,
  canClose: boolean,
  watch: string | null,
): string {
  // Capitalised here rather than held as a second record: the words are
  // `deliveryHold`'s, and two records is how the two sentences come to disagree.
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
  // this row is closable whatever it says.
  if (watch !== null) lines.push('', watch);
  if (issue.url) lines.push('', issue.url);
  return lines.join('\n');
}

/**
 * The count, in words, on the terms the verdict counts in: `unrun` and `deferred` are named
 * as outstanding rather than folded into a single "not passed", because the two are the
 * ones an operator is most likely to believe are fine.
 */
export function validationHeadline(verdict: ValidationVerdict): string {
  const parts: string[] = [];
  if (verdict.failed > 0) parts.push(`${verdict.failed} failed`);
  if (verdict.unrun > 0) parts.push(`${verdict.unrun} never run`);
  if (verdict.deferred > 0) parts.push(`${verdict.deferred} deferred`);
  const owed = parts.length > 0 ? parts.join(', ') : 'checks outstanding';
  return `Validation is not clear on this goal — ${owed}, of ${verdict.total}.`;
}

/** The tracker item a close-out row names, or null for an origin that is not an issue. */
export function closeOutIssueNumber(originRef: string | null): number | null {
  if (originRef === null) return null;
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}
