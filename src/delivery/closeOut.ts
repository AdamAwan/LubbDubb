import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import { DELIVERY_AUTHOR } from './delivery.js';
import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { HumanTask, Issue, IssueDelivery, IssueShortfall, ValidationVerdict } from '../types.js';

// → docs/spec/24-environments.md

type CloseOutStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
  | { kind: 'file-outcome'; originRef: string; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done' | 'declined'; resolution: string }
  | { kind: 'reopen'; taskId: string; detail: string };

interface CloseOutInput {
  issues: readonly Issue[];
  deliveries: readonly IssueDelivery[];
  shortfalls: readonly IssueShortfall[];
  existing: readonly HumanTask[];
  validation: ReadonlyMap<string, { verdict: ValidationVerdict; outstanding: readonly string[] }>;
  /** Each goal's criteria, one line per criterion as it was read. → 20-validation.md#satisfies-and-the-goals-criteria */
  criteria?: ReadonlyMap<string, readonly string[]>;
  opened: ReadonlySet<string> | null;
  validating: ReadonlySet<string>;
  watch: ReadonlyMap<string, string>;
  watchCleared: ReadonlySet<string> | null;
  canClose: boolean;
  /**
   * The goals that owe the second scoring moment, as origin refs and nothing else.
   * The desk is handed refs deliberately: this pass composes prose that is persisted
   * as a human task and served to surfaces that are not the cockpit, and what the
   * operator wrote at the gate is a measurement of the fleet that must reach none of
   * them. The row names the goal; the cockpit fetches the rest by itself.
   */
  outcomeOwed?: ReadonlySet<string>;
  /** The `outcome` rows already on the bench, the way `existing` holds the close-outs. */
  existingOutcome?: readonly HumanTask[];
}

export function closeOutPass(input: CloseOutInput): CloseOutStep[] {
  const byOrigin = new Map(input.existing.map((t) => [t.originRef ?? '', t]));
  const inWorld = new Map(input.issues.map((i) => [issueOriginRef('root', i.number), i]));
  const shortfalls = new Set(input.shortfalls.map((s) => s.originRef));
  const delivered = new Set(input.deliveries.map((d) => d.originRef));
  const steps: CloseOutStep[] = [];

  for (const delivery of input.deliveries) {
    const originRef = delivery.originRef;
    if (closeOutIssueNumber(originRef) === null) continue;
    if (shortfalls.has(originRef)) continue;
    const existing = byOrigin.get(originRef);
    const issue = inWorld.get(originRef);

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
            input.criteria?.get(originRef) ?? [],
          ),
        });
      continue;
    }

    if (issue?.state === 'closed') {
      if (existing)
        steps.push({ kind: 'settle', taskId: existing.id, status: 'done', resolution: 'the tracker shows it closed' });
      continue;
    }
    if (!issue) {
      if (existing && input.issues.length > 0)
        steps.push({
          kind: 'settle',
          taskId: existing.id,
          status: 'done',
          resolution: 'the tracker no longer lists it open',
        });
      continue;
    }

    if (!existing) {
      if (input.opened !== null && !input.opened.has(originRef)) continue;
      if (input.validating.has(originRef)) continue;
      if (input.watchCleared !== null && !input.watchCleared.has(originRef)) continue;
    }

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
        input.criteria?.get(originRef) ?? [],
      ),
    });
  }

  for (const task of input.existing) {
    if (task.status !== 'open' || !task.originRef || delivered.has(task.originRef)) continue;
    steps.push({
      kind: 'settle',
      taskId: task.id,
      status: 'declined',
      resolution: DESK_SETTLED + 'the goal went back into production — there is no delivery to close it out',
    });
  }

  steps.push(...outcomePass(input, { inWorld, shortfalls, delivered, closeOuts: steps }));

  return steps;
}

/**
 * The second scoring moment's row: "was the plan right?", asked once the goal is
 * delivered and the close-out in front of it has been dealt with.
 *
 * It rides this bench rather than becoming a queue of its own. A separate queue for
 * an optional feature is the thing that decays first, and this is a surface the
 * operator already has to clear.
 *
 * It is sequenced behind the `close_out` row for the same reason that row is
 * sequenced behind the `validate` one: filed together, the bench asks two things in
 * one breath and the second reads as optional.
 */
function outcomePass(
  input: CloseOutInput,
  seen: {
    inWorld: ReadonlyMap<string, Issue>;
    shortfalls: ReadonlySet<string>;
    delivered: ReadonlySet<string>;
    /** What the close-out half of this same pass decided, which is half the sequence. */
    closeOuts: readonly CloseOutStep[];
  },
): CloseOutStep[] {
  const steps: CloseOutStep[] = [];
  const owed = input.outcomeOwed ?? new Set<string>();
  const existingOutcome = input.existingOutcome ?? [];
  const byOrigin = new Map(existingOutcome.map((t) => [t.originRef ?? '', t]));
  // A close-out standing open, or filed on this very pass. The second half matters
  // as much as the first: the pulse a goal is delivered on files its close-out, and
  // without it the two rows would arrive together — which is the thing the sequence
  // exists to stop.
  const closingOut = new Set([
    ...input.existing.filter((t) => t.status === 'open' && t.originRef !== null).map((t) => t.originRef!),
    ...seen.closeOuts.filter((s) => s.kind === 'file').map((s) => s.originRef),
  ]);

  for (const delivery of input.deliveries) {
    const originRef = delivery.originRef;
    if (closeOutIssueNumber(originRef) === null) continue;
    if (seen.shortfalls.has(originRef)) continue;
    const existing = byOrigin.get(originRef);

    if (!owed.has(originRef)) {
      // Answered, or never asked — and those are the same step, because a row is
      // only ever filed against a goal that owed the moment in the first place.
      if (existing?.status === 'open')
        steps.push({
          kind: 'settle',
          taskId: existing.id,
          status: 'done',
          resolution: DESK_SETTLED + 'the second moment was answered',
        });
      continue;
    }
    if (existing) {
      if (existing.status !== 'open' && deskSettled(existing))
        steps.push({ kind: 'reopen', taskId: existing.id, detail: outcomeDetail(seen.inWorld.get(originRef) ?? null) });
      continue;
    }
    if (closingOut.has(originRef)) continue;

    steps.push({
      kind: 'file-outcome',
      originRef,
      title: outcomeTitle(closeOutIssueNumber(originRef)!),
      detail: outcomeDetail(seen.inWorld.get(originRef) ?? null),
    });
  }

  for (const task of existingOutcome) {
    if (task.status !== 'open' || !task.originRef || seen.delivered.has(task.originRef)) continue;
    steps.push({
      kind: 'settle',
      taskId: task.id,
      status: 'declined',
      resolution: DESK_SETTLED + 'the goal went back into production — the plan it delivered is not the one to judge',
    });
  }

  return steps;
}

function outcomeTitle(issueNumber: number): string {
  return `Say whether the plan for #${issueNumber} turned out right`;
}

/**
 * Names the goal and nothing else.
 *
 * What the operator predicted stays where it was written. This string is persisted,
 * is read back by the operator's own desktop channel, and is one careless edit from
 * a tracker comment — and a prediction is a measurement of the fleet, worthless the
 * moment anything the fleet reads can name it. The cockpit draws the slots from
 * `GET /api/goals/:number/prediction`, which is the record's one reader.
 */
function outcomeDetail(issue: Issue | null): string {
  const lines = [
    issue === null ? 'This goal is delivered.' : `**${issue.title}** is delivered and its close-out is done with.`,
    '',
    'You marked how your prediction stood against the plan. This asks the other question: slot by ' +
      'slot, did the **plan** turn out to be right? Open the goal to answer it — or decline this row, ' +
      'which records the moment as unanswered and never as a wrong plan.',
  ];
  if (issue?.url) lines.push('', issue.url);
  return lines.join('\n');
}

function closeOutTitle(issueNumber: number): string {
  return `Close issue #${issueNumber} in the tracker`;
}

function closeOutDetail(
  issue: Issue,
  delivery: IssueDelivery,
  validation: { verdict: ValidationVerdict; outstanding: readonly string[] } | null,
  canClose: boolean,
  watch: string | null,
  criteria: readonly string[],
): string {
  const author = DELIVERY_AUTHOR[delivery.by];
  const by = author.charAt(0).toUpperCase() + author.slice(1);
  const lines = [
    `${by} marked **${issue.title}** delivered${delivery.summary ? ` — "${delivery.summary}"` : ''}.`,
    '',
    canClose
      ? 'The item is still open in the tracker. **Mark as closed** here does it and settles this row with it — or close it in the tracker yourself and this settles itself on the next pulse, or mark it done here, or decline it and say why.'
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
  if (criteria.length > 0) lines.push('', '**Your criteria**', '', ...criteria);
  if (watch !== null) lines.push('', watch);
  if (issue.url) lines.push('', issue.url);
  return lines.join('\n');
}

export function validationHeadline(verdict: ValidationVerdict): string {
  const parts: string[] = [];
  if (verdict.failed > 0) parts.push(`${verdict.failed} failed`);
  if (verdict.unrun > 0) parts.push(`${verdict.unrun} never run`);
  if (verdict.deferred > 0) parts.push(`${verdict.deferred} deferred`);
  if (verdict.captured > 0) parts.push(`${verdict.captured} captured and waiting to be looked at`);
  if (verdict.declined > 0) parts.push(`${verdict.declined} declined by you at the accept gate`);
  const owed = parts.length > 0 ? parts.join(', ') : 'checks outstanding';
  return `Validation is not clear on this goal — ${owed}, of ${verdict.total}.`;
}

export function closeOutIssueNumber(originRef: string | null): number | null {
  return issueOriginNumber('root', originRef);
}
