import type { Plan, PlanAtom, PlanPart } from '../types.js';
import type { PlanDocument } from './planDocument.js';
import { validatePlanDocument } from './planDocument.js';
import { liveParts, partHasWork } from './parts.js';

// → docs/spec/08-planning.md#regrouping

interface RegroupGroup {
  slug: string;
  atoms: string[];
  title?: string | null;
  scope?: string | null;
}

type RegroupResult = { ok: true; document: PlanDocument } | { ok: false; error: string };

export function regroupRefusal(plan: Plan, parts: PlanPart[], atoms: PlanAtom[]): string | null {
  if (plan.status !== 'awaiting_approval')
    return (
      `The plan for ${plan.originRef} is "${plan.status}", and only a plan still awaiting approval is regrouped ` +
      'in place. ' +
      (plan.status === 'active'
        ? 'Its parts are already scheduling, so a change to it is an amendment its author proposes and you accept.'
        : plan.status === 'planning'
          ? 'A planner already has it, and the document it writes replaces this one wholesale.'
          : 'Nothing schedules from it any more, so there is no grouping left to change.')
    );
  if (plan.reason === null || plan.reason.trim() === '')
    return (
      `The plan for ${plan.originRef} was stored without a reason, and a plan document needs one — a regroup ` +
      'writes the whole document back, so there is nothing here to write it from.'
    );
  if (atoms.length === 0)
    return (
      `The plan for ${plan.originRef} declares no atoms, so there is nothing to regroup — its parts are the ` +
      'only pieces it names.'
    );
  const working = liveParts(parts).filter(partHasWork);
  if (working.length > 0) {
    const named = working
      .map((p) => `"${p.slug}" (${p.status}${p.prNumber === null ? '' : `, PR #${p.prNumber}`})`)
      .join(', ');
    return (
      `The plan for ${plan.originRef} has work in flight on ${named}, and a part with a branch or a pull ` +
      'request is progress rather than a proposal. Regrouping rewrites where the merge boundaries fall, which ' +
      'is not a thing that can be done to work already being carried out.'
    );
  }
  return null;
}

export function regroupedDocument(input: {
  plan: Plan;
  parts: PlanPart[];
  atoms: PlanAtom[];
  groups: RegroupGroup[];
}): RegroupResult {
  const { plan, atoms } = input;
  const refusal = regroupRefusal(plan, input.parts, atoms);
  if (refusal !== null) return { ok: false, error: refusal };

  const existing = new Map(liveParts(input.parts).map((p) => [p.slug, p]));
  const seen = new Set<string>();
  for (const group of input.groups) {
    if (seen.has(group.slug)) return { ok: false, error: `"${group.slug}" is named twice — one part, one slug.` };
    seen.add(group.slug);
    if (existing.has(group.slug)) continue;
    if (!group.title?.trim() || !group.scope?.trim())
      return {
        ok: false,
        error: `"${group.slug}" is a new part, so it needs a title and a scope saying what it achieves.`,
      };
  }

  const kept = new Set(input.groups.map((g) => g.slug));
  const carrier = new Map<string, string>();
  for (const group of input.groups) for (const slug of group.atoms) carrier.set(slug, group.slug);
  const byAtom = new Map(atoms.map((a) => [a.slug, a]));

  const parts = input.groups.map((group) => {
    const part = existing.get(group.slug);
    const declared = part === undefined ? [] : part.dependsOn.filter((d) => kept.has(d) && d !== group.slug);
    const implied = group.atoms.flatMap((slug) =>
      (byAtom.get(slug)?.dependsOn ?? []).flatMap((dep) => {
        const holder = carrier.get(dep);
        return holder === undefined || holder === group.slug ? [] : [holder];
      }),
    );
    return {
      slug: group.slug,
      title: part?.title ?? group.title?.trim(),
      scope: part?.scope ?? group.scope?.trim(),
      atoms: group.atoms,
      dependsOn: [...new Set([...declared, ...implied])].sort((a, b) => a.localeCompare(b)),
      ...(part === undefined ? {} : statedTouches(part, byAtom)),
      ...(part?.rationale ? { rationale: part.rationale } : {}),
      ...(part?.acceptance ? { acceptance: part.acceptance } : {}),
      ...(part?.size ? { size: part.size } : {}),
      ...(part?.expectedKind ? { expectedKind: part.expectedKind } : {}),
      ...(part?.profile ? { profile: part.profile } : {}),
    };
  });

  const parsed = validatePlanDocument({
    version: 1,
    reason: plan.reason,
    ...prose(plan),
    evidence: plan.evidence.map((e) => ({
      path: e.path,
      ...(e.line === null ? {} : { line: e.line }),
      ...(e.note === null ? {} : { note: e.note }),
    })),
    atoms: atoms.map((atom) => ({
      slug: atom.slug,
      title: atom.title,
      intent: atom.intent,
      touches: atom.touches,
      ...(atom.acceptance === null ? {} : { acceptance: atom.acceptance }),
      dependsOn: atom.dependsOn,
      rejected: atom.rejected,
    })),
    parts,
  });
  return parsed.ok ? parsed : { ok: false, error: `Regroup refused: ${parsed.error}` };
}

function statedTouches(part: PlanPart, byAtom: Map<string, PlanAtom>): { touches?: string[] } {
  const carried = part.atoms ?? [];
  const derived = new Set(carried.flatMap((slug) => byAtom.get(slug)?.touches ?? []));
  const same = derived.size === part.touches.length && part.touches.every((path) => derived.has(path));
  return same ? {} : { touches: part.touches };
}

function prose(plan: Plan): Record<string, string> {
  const fields = {
    diagnosis: plan.diagnosis,
    approach: plan.approach,
    risks: plan.risks,
    outOfScope: plan.outOfScope,
    alternatives: plan.alternatives,
    openQuestions: plan.openQuestions,
    verification: plan.verification,
    document: plan.document,
  };
  return Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => (value ? [[key, value]] : [])));
}
