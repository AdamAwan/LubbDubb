import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import { DELIVERY_AUTHOR } from './delivery.js';
import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { HumanTask, Issue, IssueDelivery, IssueShortfall, ValidationVerdict } from '../types.js';

// → docs/spec/24-environments.md

type CloseOutStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
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
    const step = closeOutStep(input, delivery, byOrigin.get(originRef), inWorld.get(originRef));
    if (step) steps.push(step);
  }

  steps.push(
    ...declineUndelivered(
      input.existing,
      delivered,
      'the goal went back into production — there is no delivery to close it out',
    ),
  );

  return steps;
}

function closeOutStep(
  input: CloseOutInput,
  delivery: IssueDelivery,
  existing: HumanTask | undefined,
  issue: Issue | undefined,
): CloseOutStep | null {
  const originRef = delivery.originRef;
  if (existing && existing.status !== 'open') {
    if (deskSettled(existing) && issue && issue.state !== 'closed')
      return { kind: 'reopen', taskId: existing.id, detail: deliveryDetail(input, issue, delivery) };
    return null;
  }

  if (issue?.state === 'closed') {
    if (existing)
      return { kind: 'settle', taskId: existing.id, status: 'done', resolution: 'the tracker shows it closed' };
    return null;
  }
  if (!issue) {
    if (existing && input.issues.length > 0)
      return {
        kind: 'settle',
        taskId: existing.id,
        status: 'done',
        resolution: 'the tracker no longer lists it open',
      };
    return null;
  }

  if (!existing && !readyToFile(input, originRef)) return null;

  return {
    kind: 'file',
    originRef,
    title: closeOutTitle(issue.number),
    detail: deliveryDetail(input, issue, delivery),
  };
}

function readyToFile(input: CloseOutInput, originRef: string): boolean {
  if (input.opened !== null && !input.opened.has(originRef)) return false;
  if (input.validating.has(originRef)) return false;
  if (input.watchCleared !== null && !input.watchCleared.has(originRef)) return false;
  return true;
}

function deliveryDetail(input: CloseOutInput, issue: Issue, delivery: IssueDelivery): string {
  const originRef = delivery.originRef;
  return closeOutDetail(
    issue,
    delivery,
    input.validation.get(originRef) ?? null,
    input.canClose,
    input.watch.get(originRef) ?? null,
    input.criteria?.get(originRef) ?? [],
  );
}

function declineUndelivered(
  tasks: readonly HumanTask[],
  delivered: ReadonlySet<string>,
  resolution: string,
): CloseOutStep[] {
  const steps: CloseOutStep[] = [];
  for (const task of tasks) {
    if (task.status !== 'open' || !task.originRef || delivered.has(task.originRef)) continue;
    steps.push({ kind: 'settle', taskId: task.id, status: 'declined', resolution: DESK_SETTLED + resolution });
  }
  return steps;
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
