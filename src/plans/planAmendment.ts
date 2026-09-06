import type { Store } from '../store/store.js';
import type { Plan, PlanAmendment, PlanAmendmentAuthor, PlanPart, PlanPartInput } from '../types.js';
import { validatePlanDocument, planNarrative, planPartInputs } from './planDocument.js';
import { ingestPlanDocument } from './planIngest.js';
import { proposedPlanDiff } from './planDiff.js';
import type { PlanDiff } from './planDiff.js';
import { liveParts, partHasWork, partSettled } from './parts.js';

/**
 * Changing a plan that is **already running**, without stopping it: a proposal
 * against a live plan, held in `plan_amendments`. Three properties:
 *
 * - **Nothing here touches `plans` or `plan_parts`** — the plan keeps scheduling
 *   while the question is open.
 * - **Nobody but an operator applies it**, whichever author proposed it.
 * - **Applying it is the ordinary ingestion** ({@link ingestPlanDocument}), which
 *   merges on slug and spares any part work was started for.
 *
 * An `awaiting_approval` plan is **not** amended through here — it is amended in
 * place via `plan_amend`. → [08](../../docs/spec/08-planning.md)
 */

/** The outcome of proposing, applying or withdrawing an amendment, in the shape every caller audits. */
interface AmendmentResult {
  ok: boolean;
  detail: string;
}

/** What a caller gets back when a proposal lands: the row, and what the operator will be shown. */
interface ProposedAmendment {
  amendment: PlanAmendment;
  /** The change as a diff against the plan's latest revision. Null on a plan with no revision. */
  diff: PlanDiff | null;
  /** What applying it would leave standing that the author may not have meant. */
  warnings: string[];
}

/**
 * Record a change somebody wants made to a running plan.
 *
 * **Refuses on anything but `active`**, and each refusal names the route that does
 * apply ({@link wrongStatus}). **One pending amendment per plan**: accepting two
 * would apply the older document over the newer one, silently restoring the plan
 * the second author corrected.
 */
export function proposePlanAmendment(
  store: Store,
  input: {
    plan: Plan;
    /** The document as submitted; validated here, so a rejection writes nothing at all. */
    document: unknown;
    /** Why the plan must change — the whole of what the operator reads beside the diff. */
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

  // Before anything is written: a rejected document must leave the plan graph and
  // this table exactly as they were.
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
    // Serialized as submitted, re-validated where applied: what the operator approved
    // and what is ingested are one document.
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

/** The pending amendment for one plan, or null. There is at most one — see {@link proposePlanAmendment}. */
function pendingAmendmentFor(store: Store, planId: string): PlanAmendment | null {
  return store.listPlanAmendments(planId).find((a) => a.status === 'pending') ?? null;
}

/**
 * Apply an approved amendment: ingested exactly as a planner's document would be,
 * with the plan staying **released**. `approved: true` is not a shortcut past the
 * gate — without it the ingestion writes `awaiting_approval` over a running plan
 * and stops every part. Compare-and-set against the amendment row *and* the plan's
 * status, so a verdict arriving after the world moved writes nothing.
 */
export function applyPlanAmendment(store: Store, amendmentId: string): AmendmentResult {
  const amendment = store.getPlanAmendment(amendmentId);
  if (!amendment) return { ok: false, detail: `amendment ${amendmentId} no longer exists` };
  if (amendment.status !== 'pending')
    return { ok: false, detail: `amendment ${amendmentId} is "${amendment.status}" — it has already been settled` };

  const plan = store.getPlan(amendment.planId);
  if (!plan) return { ok: false, detail: `the plan for ${amendment.originRef} no longer exists` };
  if (plan.status !== 'active') {
    // Settled rather than left pending: the plan moved on, so nothing will ever apply
    // it and the operator would be asked about it for good.
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

  // Re-validated rather than trusted: an older build's row must be refused whole
  // rather than ingested in halves.
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

/**
 * Decline one: the amendment is settled and **the plan is untouched** — the one
 * settlement in the funnel with no effect on the goal, because the plan that was
 * already scheduling the work is the route.
 */
export function declinePlanAmendment(store: Store, amendmentId: string, note?: string | null): AmendmentResult {
  const settled = store.settlePlanAmendment(
    amendmentId,
    'declined',
    note?.trim() ? note.trim() : 'An operator declined this amendment; the plan is unchanged.',
  );
  if (!settled) return { ok: false, detail: `amendment ${amendmentId} was already settled — nothing changed` };
  return { ok: true, detail: `declined the amendment to the plan for ${settled.originRef}; the plan is unchanged` };
}

/**
 * Withdraw whatever is pending for a plan the world has overtaken — a replan, a
 * refusal, a back-out. Each replaces the document the amendment was written
 * against, so leaving it standing would sit in the inbox for good or be approved
 * to no effect.
 */
export function supersedePlanAmendments(store: Store, planId: string, reason: string): PlanAmendment[] {
  const settled: PlanAmendment[] = [];
  for (const amendment of store.listPlanAmendments(planId)) {
    if (amendment.status !== 'pending') continue;
    const row = store.settlePlanAmendment(amendment.id, 'superseded', reason);
    if (row) settled.push(row);
  }
  return settled;
}

/**
 * What applying this amendment would leave standing that its author may not have
 * meant — the half a diff cannot give, because it is about the plan's *rows*.
 * Three consequences of the merge: a dropped part work has started on is spared and
 * keeps running; a re-declared settled part has its declaration rewritten while the
 * delivered work stands; and a re-declared part still **in flight** is neither
 * stopped nor re-dispatched, so the agent carries on to the old specification.
 */
export function amendmentWarnings(existing: PlanPart[], declared: PlanPartInput[]): string[] {
  const keep = new Map(declared.map((p) => [p.slug, p]));
  const warnings: string[] = [];
  for (const part of liveParts(existing)) {
    const redeclared = keep.get(part.slug);
    // At most one warning per part, ordered by what is true of it: a settled part must
    // not also draw the in-flight warning, and two lines read as two parts.
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

/**
 * Which of an in-flight part's declared fields this amendment actually moves.
 * "Material" is **what the work in flight was built to**, not everything a diff can
 * name: `title`/`scope`/`acceptance` (the part's prompt), `touches`, `dependsOn`
 * (which chose the base branch) and `expectedKind`. Deliberately not material:
 * `seq`, `rationale`, `size` and `profile` (read once, at dispatch).
 *
 * Two normalisations, both saying a re-declaration of what the row already said is
 * not a change: prose is compared with whitespace collapsed, and a null
 * `expectedKind` compares as `code`, which is what null means.
 */
function materialChanges(part: PlanPart, declared: PlanPartInput): string[] {
  const changed: string[] = [];
  const compare = (field: string, from: string | null, to: string | null): void => {
    if (from !== to) changed.push(field);
  };
  compare('title', prose(part.title), prose(declared.title));
  compare('scope', prose(part.scope), prose(declared.scope));
  compare('acceptance', prose(part.acceptance), prose(declared.acceptance));
  // Order is not a difference in either list — both are sets, the reading
  // `changedFields` already takes.
  compare('paths', unordered(part.touches), unordered(declared.touches));
  compare('dependencies', unordered(part.dependsOn), unordered(declared.dependsOn));
  compare('expected outcome', part.expectedKind ?? 'code', declared.expectedKind ?? 'code');
  return changed;
}

/** Prose as it is compared: blank and absent are one thing, and a re-wrap is not a rewrite. */
function prose(text: string | null): string | null {
  if (text === null) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

/** A declared list as an order-insensitive string, for {@link materialChanges}' reason. */
function unordered(values: readonly string[]): string | null {
  return values.length === 0 ? null : [...values].sort().join(', ');
}

/**
 * The card's body: why, then what changes, then what it will not change. The
 * author's own words lead — the operator is being asked whether the reason is good.
 * The diff is named rather than rendered field by field; the full text is on the
 * plan sheet.
 */
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

/** One line per part that moved, plus one for the prose. Unchanged parts are not lines. */
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

/** Why this plan is not one an amendment can be proposed against, with the route that fits its status. */
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
