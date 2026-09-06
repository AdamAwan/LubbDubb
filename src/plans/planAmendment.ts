import type { Store } from '../store/store.js';
import type { Plan, PlanAmendment, PlanAmendmentAuthor, PlanPart, PlanPartInput } from '../types.js';
import { validatePlanDocument, planNarrative, planPartInputs } from './planDocument.js';
import { ingestPlanDocument } from './planIngest.js';
import { proposedPlanDiff } from './planDiff.js';
import type { PlanDiff } from './planDiff.js';
import { liveParts, partHasWork, partSettled } from './parts.js';

// → docs/spec/08-planning.md

interface AmendmentResult {
  ok: boolean;
  detail: string;
}

interface ProposedAmendment {
  amendment: PlanAmendment;
  diff: PlanDiff | null;
  warnings: string[];
}

export function proposePlanAmendment(
  store: Store,
  input: {
    plan: Plan;
    document: unknown;
    note: string;
    author: PlanAmendmentAuthor;
    authorRef: string | null;
  },
): { ok: true; proposed: ProposedAmendment } | { ok: false; error: string } {
  const { plan } = input;
  if (plan.status !== 'active') return { ok: false, error: wrongStatus(plan) };

  const standing = pendingAmendmentFor(store, plan.id);
  if (standing) {
    return {
      ok: false,
      error:
        `The plan for ${plan.originRef} already has an amendment waiting on the operator, proposed ` +
        `${standing.createdAt}: "${standing.note}". Wait for them to answer it, or fold what you have into it ` +
        'once they have — two amendments in front of one person are two descriptions of the same plan, and ' +
        'accepting both would apply the older document over the newer one.',
    };
  }

  const parsed = validatePlanDocument(input.document);
  if (!parsed.ok) return { ok: false, error: `Amendment rejected: ${parsed.error}` };

  const note = input.note.trim();
  if (note === '')
    return {
      ok: false,
      error:
        'An amendment needs a reason. It is the whole of what an operator reads beside the diff, and a change ' +
        'to a plan agents are working with no reason on it is one they cannot answer.',
    };

  const parts = store.listPlanParts(plan.id);
  const declared = planPartInputs(parsed.document);
  const amendment = store.recordPlanAmendment({
    planId: plan.id,
    originRef: plan.originRef,
    document: JSON.stringify(parsed.document),
    note,
    author: input.author,
    authorRef: input.authorRef,
  });
  return {
    ok: true,
    proposed: {
      amendment,
      diff: proposedPlanDiff(store.listPlanRevisions(plan.id), {
        narrative: planNarrative(parsed.document),
        parts: declared,
      }),
      warnings: amendmentWarnings(parts, declared),
    },
  };
}

function pendingAmendmentFor(store: Store, planId: string): PlanAmendment | null {
  return store.listPlanAmendments(planId).find((a) => a.status === 'pending') ?? null;
}

export function applyPlanAmendment(store: Store, amendmentId: string): AmendmentResult {
  const amendment = store.getPlanAmendment(amendmentId);
  if (!amendment) return { ok: false, detail: `amendment ${amendmentId} no longer exists` };
  if (amendment.status !== 'pending')
    return { ok: false, detail: `amendment ${amendmentId} is "${amendment.status}" — it has already been settled` };

  const plan = store.getPlan(amendment.planId);
  if (!plan) return { ok: false, detail: `the plan for ${amendment.originRef} no longer exists` };
  if (plan.status !== 'active') {
    store.settlePlanAmendment(
      amendmentId,
      'superseded',
      `The plan moved to "${plan.status}" before this amendment was applied.`,
    );
    return {
      ok: false,
      detail: `the plan for ${amendment.originRef} is "${plan.status}", not active — nothing applied`,
    };
  }

  const parsed = validatePlanDocument(JSON.parse(amendment.document) as unknown);
  if (!parsed.ok) {
    store.settlePlanAmendment(amendmentId, 'superseded', `The amended plan no longer validates: ${parsed.error}`);
    return { ok: false, detail: `the amended plan for ${amendment.originRef} no longer validates: ${parsed.error}` };
  }

  const result = ingestPlanDocument(store, {
    doc: parsed.document,
    originRef: amendment.originRef,
    title: plan.title,
    approved: true,
  });
  store.settlePlanAmendment(amendmentId, 'applied', amendment.note);
  const live = liveParts(store.listPlanParts(plan.id));
  const retired = result.retired.length === 0 ? '' : `; retired ${result.retired.length} unstarted part(s)`;
  return {
    ok: true,
    detail:
      `amended the plan for ${amendment.originRef} — it is "${result.status}" with ${live.length} live part(s)` +
      `${retired}, and work already in flight kept its branches`,
  };
}

export function declinePlanAmendment(store: Store, amendmentId: string, note?: string | null): AmendmentResult {
  const settled = store.settlePlanAmendment(
    amendmentId,
    'declined',
    note?.trim() ? note.trim() : 'An operator declined this amendment; the plan is unchanged.',
  );
  if (!settled) return { ok: false, detail: `amendment ${amendmentId} was already settled — nothing changed` };
  return { ok: true, detail: `declined the amendment to the plan for ${settled.originRef}; the plan is unchanged` };
}

export function supersedePlanAmendments(store: Store, planId: string, reason: string): PlanAmendment[] {
  const settled: PlanAmendment[] = [];
  for (const amendment of store.listPlanAmendments(planId)) {
    if (amendment.status !== 'pending') continue;
    const row = store.settlePlanAmendment(amendment.id, 'superseded', reason);
    if (row) settled.push(row);
  }
  return settled;
}

export function amendmentWarnings(existing: PlanPart[], declared: PlanPartInput[]): string[] {
  const keep = new Map(declared.map((p) => [p.slug, p]));
  const warnings: string[] = [];
  for (const part of liveParts(existing)) {
    const redeclared = keep.get(part.slug);
    if (redeclared === undefined) {
      if (partHasWork(part))
        warnings.push(
          `"${part.slug}" is dropped by this amendment but work has already started on it (${part.status})` +
            `${part.prNumber === null ? '' : `, PR #${part.prNumber}`} — it keeps running. End that run yourself if it ` +
            'should stop.',
        );
      continue;
    }
    if (partSettled(part)) {
      warnings.push(
        `"${part.slug}" has already finished (${part.status}). The amendment rewrites what it was for; it does ` +
          'not change what was delivered.',
      );
      continue;
    }
    if (!partHasWork(part)) continue;
    const changed = materialChanges(part, redeclared);
    if (changed.length === 0) continue;
    warnings.push(
      `"${part.slug}" is being worked right now (${part.status})` +
        `${part.prNumber === null ? '' : `, PR #${part.prNumber}`} and this amendment rewrites its ` +
        `${changed.join(', ')}. That work was built to the old declaration, and applying this neither stops it nor ` +
        're-dispatches it — the agent carries on, and the pull request still implements what the plan used to ' +
        'say. Re-dispatch or end it yourself if the change is meant to reach it.',
    );
  }
  return warnings;
}

function materialChanges(part: PlanPart, declared: PlanPartInput): string[] {
  const changed: string[] = [];
  const compare = (field: string, from: string | null, to: string | null): void => {
    if (from !== to) changed.push(field);
  };
  compare('title', prose(part.title), prose(declared.title));
  compare('scope', prose(part.scope), prose(declared.scope));
  compare('acceptance', prose(part.acceptance), prose(declared.acceptance));
  compare('paths', unordered(part.touches), unordered(declared.touches));
  compare('dependencies', unordered(part.dependsOn), unordered(declared.dependsOn));
  compare('expected outcome', part.expectedKind ?? 'code', declared.expectedKind ?? 'code');
  return changed;
}

function prose(text: string | null): string | null {
  if (text === null) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

function unordered(values: readonly string[]): string | null {
  return values.length === 0 ? null : [...values].sort().join(', ');
}

export function describeAmendment(input: { note: string; diff: PlanDiff | null; warnings: string[] }): string {
  const blocks = [`**Why**\n\n${input.note}`];
  const changes = input.diff ? describeDiff(input.diff) : [];
  blocks.push(
    changes.length > 0
      ? `**What changes**\n\n${changes.map((c) => `- ${c}`).join('\n')}`
      : '**What changes**\n\nNothing the harness can name — the amendment re-declares the plan as it stands.',
  );
  if (input.warnings.length > 0)
    blocks.push(`**What it does not change**\n\n${input.warnings.map((w) => `- ${w}`).join('\n')}`);
  return blocks.join('\n\n');
}

function describeDiff(diff: PlanDiff): string[] {
  const lines: string[] = [];
  for (const part of diff.parts) {
    if (part.kind === 'added') lines.push(`adds "${part.slug}": ${part.title}`);
    if (part.kind === 'dropped') lines.push(`drops "${part.slug}": ${part.title}`);
    if (part.kind === 'changed') lines.push(`changes "${part.slug}" (${part.fields.map((f) => f.field).join(', ')})`);
  }
  if (diff.narrative.length > 0) lines.push(`rewrites the plan's ${diff.narrative.map((n) => n.field).join(', ')}`);
  return lines;
}

function wrongStatus(plan: Plan): string {
  const routes: Record<string, string> = {
    awaiting_approval:
      'nothing has been scheduled off it yet, so amend it in place — the operator is about to answer for this ' +
      'plan, and the change belongs in the plan they read',
    planning: 'a planner already has it, and the document it writes replaces this one wholesale',
    complete:
      'its parts are all finished, so there is no schedule left for an amendment to keep running — more ' +
      'work on a delivered goal is an instruction on the goal',
    abandoned: 'it was stopped deliberately, and nothing schedules from it',
  };
  const why = routes[plan.status] ?? 'it is not running';
  return `The plan for ${plan.originRef} is "${plan.status}", not active: ${why}.`;
}
