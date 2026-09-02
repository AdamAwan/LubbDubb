import type { Store } from '../store/store.js';
import type { Plan, PlanAmendment, PlanAmendmentAuthor, PlanPart } from '../types.js';
import { validatePlanDocument, planNarrative, planPartInputs } from './planDocument.js';
import { ingestPlanDocument } from './planIngest.js';
import { proposedPlanDiff } from './planDiff.js';
import type { PlanDiff } from './planDiff.js';
import { liveParts, partHasWork, partSettled } from './parts.js';

/**
 * Changing a plan that is **already running**, without stopping it.
 *
 * The funnel's one answer to "this plan is wrong" used to be a replan: flip the
 * row back to `planning`, spend a planning agent re-deriving the whole
 * decomposition, and put every part of it back through the approval gate. That is
 * the right answer when the *shape* of the work was wrong and the wrong one for
 * everything else — a part whose scope drifted, a dependency that turned out to be
 * the other way round, a step nobody needs any more. An agent halfway through the
 * work is the reader most likely to notice one of those, and had nowhere to put it.
 *
 * So an amendment is a **proposal against a live plan**, and the three properties
 * that makes it worth having are all properties of *not* writing:
 *
 * - **The plan keeps scheduling while the question is open.** Nothing here touches
 *   `plans` or `plan_parts`; the amended document sits in `plan_amendments` and the
 *   parts that were dispatchable stay dispatchable. A replan's cost is that the
 *   whole goal waits on a planner and then on a human; an amendment's cost is one
 *   card in the inbox.
 * - **Nobody but an operator applies it.** Both authors — an agent through the
 *   fleet's `plan_correct`, an operator's own Claude Code through `plan_amend` —
 *   reach the same pending row. A plan under way that rewrote itself on an agent's
 *   say-so would change what other agents were dispatched against mid-flight, which
 *   is precisely what the approval gate exists to stop happening once.
 * - **Applying it is the ordinary ingestion.** {@link ingestPlanDocument} merges on
 *   slug, so a part with a branch, a pull request or an outcome keeps all three and
 *   only its declaration is refreshed, and `partsToRetire` spares any part work was
 *   started for. There is no second write path here that could disagree with the
 *   one every other plan takes.
 *
 * What it is *not* is a way around the plan gate. An `awaiting_approval` plan is
 * not amended through here — it is amended in place, because nothing is scheduled
 * off it yet and the card the operator is about to answer is the card that should
 * carry the change (`plan_amend`, → [08](../../docs/spec/08-planning.md)).
 */

/** The outcome of proposing, applying or withdrawing an amendment, in the shape every caller audits. */
interface AmendmentResult {
  ok: boolean;
  detail: string;
}

/** What a caller gets back when a proposal lands: the row, and what the operator will be shown. */
export interface ProposedAmendment {
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
 * apply, because a caller told only "no" writes its correction into a comment
 * nobody reads:
 *
 * - `awaiting_approval` — nothing is scheduled yet, so the amendment belongs *in*
 *   the plan the operator is about to answer for, not beside it.
 * - `planning` — a planner already has it, and its document is about to be
 *   replaced wholesale.
 * - `complete` / `abandoned` — there is no schedule left to keep running, which is
 *   the whole thing this holds open. More work on a delivered goal is an
 *   instruction on the goal ([16](../../docs/spec/16-http-api.md)).
 *
 * **One pending amendment per plan.** A second would put two cards in front of an
 * operator, each describing the plan as if the other did not exist, and accepting
 * both would apply the older one's document over the newer one's — the plan the
 * second author corrected would silently come back. The refusal names the standing
 * one so the author can fold their change into it.
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

  // Before anything is written, for `plan_submit`'s reason: a rejected document
  // leaves the plan graph — and this table — exactly as it was, and the retry is
  // against an unchanged plan.
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
    // Serialized as submitted and re-validated where it is applied, so what the
    // operator approved and what is ingested are one document.
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
      warnings: amendmentWarnings(
        parts,
        declared.map((p) => p.slug),
      ),
    },
  };
}

/** The pending amendment for one plan, or null. There is at most one — see {@link proposePlanAmendment}. */
export function pendingAmendmentFor(store: Store, planId: string): PlanAmendment | null {
  return store.listPlanAmendments(planId).find((a) => a.status === 'pending') ?? null;
}

/**
 * Apply an approved amendment: the document is ingested exactly as a planner's
 * would be, and the plan stays **released**.
 *
 * `approved: true` is the whole of the difference, and it is not a shortcut past
 * the gate — the gate was the card the operator just answered. Without it the
 * ingestion writes `awaiting_approval` back over a running plan and stops every
 * part of it, which is the failure this surface exists to avoid.
 *
 * Compare-and-set twice, against the amendment row *and* the plan's status, for
 * `releasePlan`'s reason: a verdict that arrives after the world moved — a replan
 * started with the card still open — must not write a document nobody was shown
 * over a plan that is no longer the one it amends.
 */
export function applyPlanAmendment(store: Store, amendmentId: string): AmendmentResult {
  const amendment = store.getPlanAmendment(amendmentId);
  if (!amendment) return { ok: false, detail: `amendment ${amendmentId} no longer exists` };
  if (amendment.status !== 'pending')
    return { ok: false, detail: `amendment ${amendmentId} is "${amendment.status}" — it has already been settled` };

  const plan = store.getPlan(amendment.planId);
  if (!plan) return { ok: false, detail: `the plan for ${amendment.originRef} no longer exists` };
  if (plan.status !== 'active') {
    // Settled rather than left pending: the plan it amends has moved on, so
    // nothing will ever apply it, and a row that cannot be settled is one an
    // operator is asked about for good.
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

  // Re-validated rather than trusted: the row may have been written by an older
  // build, and a document the schema has since moved past must be refused whole
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
 * Decline one: the amendment is settled and **the plan is untouched**.
 *
 * The one settlement in the funnel with no effect on the goal at all, and
 * deliberately so. A refused *plan* has to leave the issue a route, because a plan
 * is the only thing that schedules work for a planned issue; a refused amendment
 * leaves the plan that was already scheduling it, which is the route. Saying no to
 * a correction is saying "carry on as planned".
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
 * refusal, a back-out.
 *
 * Every one of those replaces the document an amendment was written against, so
 * the question it puts to an operator is about a plan that no longer exists.
 * Leaving it standing would either sit in the inbox for good (the apply above
 * refuses outside `active`) or be answered "yes" to no effect, which is worse:
 * an operator who approved a change and saw nothing happen learns not to trust the
 * card.
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
 * meant — the half of the reading a diff cannot give, because it is about the
 * plan's *rows* rather than its declarations.
 *
 * Both warnings are consequences of the merge that makes an amendment safe in the
 * first place. A dropped part that work was started for is spared by
 * `partsToRetire`, so the amendment does not stop it — the agent on it carries on,
 * and only the operator can end that run. A re-declared part that has already
 * settled has its *declaration* rewritten while the work it produced stays exactly
 * as it was, so the plan would then describe delivered work in terms nobody
 * delivered it under.
 */
export function amendmentWarnings(existing: PlanPart[], declared: string[]): string[] {
  const keep = new Set(declared);
  const warnings: string[] = [];
  for (const part of liveParts(existing)) {
    if (!keep.has(part.slug) && partHasWork(part)) {
      warnings.push(
        `"${part.slug}" is dropped by this amendment but work has already started on it (${part.status})` +
          `${part.prNumber === null ? '' : `, PR #${part.prNumber}`} — it keeps running. End that run yourself if it ` +
          'should stop.',
      );
    }
    if (keep.has(part.slug) && partSettled(part)) {
      warnings.push(
        `"${part.slug}" has already finished (${part.status}). The amendment rewrites what it was for; it does ` +
          'not change what was delivered.',
      );
    }
  }
  return warnings;
}

/**
 * The card's body: why, then what changes, then what it will not change.
 *
 * The author's own words lead, for `planApprovalDetail`'s reason — it is the one
 * thing the diff cannot show, and the operator is being asked whether the *reason*
 * is good. The diff is named rather than rendered field by field: which parts moved
 * is the reading a decision is taken on, and the full text is one click away on the
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
