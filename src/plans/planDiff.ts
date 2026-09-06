import type { PlanNarrative, PlanPartInput, PlanRevision } from '../types.js';

// → docs/spec/08-planning.md

type Snapshot = { seq: number; narrative: PlanNarrative; parts: PlanPartInput[] };

type PartChangeKind = 'added' | 'dropped' | 'changed' | 'unchanged';

interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

interface PartChange {
  slug: string;
  kind: PartChangeKind;
  title: string;
  fields: FieldChange[];
}

interface NarrativeChange {
  field: keyof PlanNarrative;
  kind: 'written' | 'rewritten' | 'cleared';
}

export interface PlanDiff {
  seq: number;
  againstSeq: number;
  parts: PartChange[];
  narrative: NarrativeChange[];
}

export function latestPlanDiff(revisions: PlanRevision[]): PlanDiff | null {
  if (revisions.length < 2) return null;
  const [prev, next] = [revisions[revisions.length - 2], revisions[revisions.length - 1]];
  if (prev === undefined || next === undefined) return null;
  return diffPlanRevisions(prev, next);
}

export function proposedPlanDiff(
  revisions: PlanRevision[],
  proposed: { narrative: PlanNarrative; parts: PlanPartInput[] },
): PlanDiff | null {
  const prev = revisions[revisions.length - 1];
  if (prev === undefined) return null;
  return diffPlanRevisions(prev, { ...proposed, seq: prev.seq + 1 });
}

function diffPlanRevisions(prev: Snapshot, next: Snapshot): PlanDiff {
  return {
    seq: next.seq,
    againstSeq: prev.seq,
    parts: diffParts(prev.parts, next.parts),
    narrative: diffNarrative(prev.narrative, next.narrative),
  };
}

function diffParts(prev: PlanPartInput[], next: PlanPartInput[]): PartChange[] {
  const before = new Map(prev.map((p) => [p.slug, p]));
  const after = new Map(next.map((p) => [p.slug, p]));
  const changes: PartChange[] = next.map((part) => {
    const old = before.get(part.slug);
    if (old === undefined) return { slug: part.slug, kind: 'added', title: part.title, fields: [] };
    const fields = changedFields(old, part);
    return {
      slug: part.slug,
      kind: fields.length > 0 ? 'changed' : 'unchanged',
      title: part.title,
      fields,
    };
  });
  for (const part of prev) {
    if (!after.has(part.slug)) changes.push({ slug: part.slug, kind: 'dropped', title: part.title, fields: [] });
  }
  return changes;
}

function changedFields(prev: PlanPartInput, next: PlanPartInput): FieldChange[] {
  const out: FieldChange[] = [];
  const compare = (field: string, from: string | null, to: string | null): void => {
    if (from !== to) out.push({ field, from, to });
  };
  compare('title', prev.title, next.title);
  compare('scope', prev.scope, next.scope);
  compare('touches', listOf(prev.touches), listOf(next.touches));
  compare('dependsOn', listOf([...prev.dependsOn].sort()), listOf([...next.dependsOn].sort()));
  compare('rationale', prev.rationale, next.rationale);
  compare('acceptance', prev.acceptance, next.acceptance);
  compare('size', prev.size, next.size);
  compare('expectedKind', prev.expectedKind, next.expectedKind);
  return out;
}

function listOf(values: string[]): string | null {
  return values.length === 0 ? null : values.join(', ');
}

function diffNarrative(prev: PlanNarrative, next: PlanNarrative): NarrativeChange[] {
  const fields: (keyof PlanNarrative)[] = [
    'diagnosis',
    'approach',
    'reason',
    'verification',
    'alternatives',
    'openQuestions',
    'risks',
    'outOfScope',
    'document',
    'evidence',
  ];
  const out: NarrativeChange[] = [];
  for (const field of fields) {
    const from = narrativeText(prev, field);
    const to = narrativeText(next, field);
    if (from === to) continue;
    out.push({ field, kind: to === null ? 'cleared' : from === null ? 'written' : 'rewritten' });
  }
  return out;
}

function narrativeText(narrative: PlanNarrative, field: keyof PlanNarrative): string | null {
  if (field === 'evidence') {
    if (narrative.evidence.length === 0) return null;
    return narrative.evidence.map((e) => `${e.path}:${e.line ?? ''}:${e.note ?? ''}`).join('\n');
  }
  return narrative[field];
}
