import type { PlanNarrative, PlanPartInput, PlanRevision } from '../types.js';

/**
 * What one amendment did to the plan before it — the reading an operator needs and
 * has never had.
 *
 * A replan and a discussion both rewrite the plan row in place, so what came back
 * from ten minutes of conversation was the whole decomposition again, with nothing
 * anywhere saying which two parts moved. Everything here is pure over two
 * {@link PlanRevision} snapshots; the store writes them and this reads them, and
 * neither knows about the other's timing.
 *
 * **A diff of declarations, not of the plan's rows.** A part the amendment dropped
 * but which kept running (because work had started, so `partsToRetire` spared it)
 * is `dropped` here and live on the plan — both true, and the pair is exactly what
 * the sheet warns about.
 */

/** What happened to one part across an amendment. */
type PartChangeKind = 'added' | 'dropped' | 'changed' | 'unchanged';

/** One declared field that moved, with both sides for the reader to compare. */
interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

interface PartChange {
  slug: string;
  kind: PartChangeKind;
  /** The title on whichever side exists — the new one when both do. */
  title: string;
  /** Empty unless `kind` is `changed`. */
  fields: FieldChange[];
}

/** Which plan-level fields were rewritten. Named, never diffed word by word — see below. */
interface NarrativeChange {
  field: keyof PlanNarrative;
  /** `written` covers a field that had nothing before: "rewritten" would overclaim. */
  kind: 'written' | 'rewritten' | 'cleared';
}

export interface PlanDiff {
  /** The revision this is a diff *of*. */
  seq: number;
  /** The revision it is a diff *against* — always `seq - 1` as things stand. */
  againstSeq: number;
  parts: PartChange[];
  narrative: NarrativeChange[];
}

/**
 * Diff the last two revisions of a plan, or null when there is only one.
 *
 * Null rather than a diff against nothing: a first plan is not an amendment,
 * and drawing every part of it as "added" would be a change log for a plan nobody
 * had seen before.
 */
export function latestPlanDiff(revisions: PlanRevision[]): PlanDiff | null {
  if (revisions.length < 2) return null;
  const [prev, next] = [revisions[revisions.length - 2], revisions[revisions.length - 1]];
  if (prev === undefined || next === undefined) return null;
  return diffPlanRevisions(prev, next);
}

/** The pure comparison. */
function diffPlanRevisions(prev: PlanRevision, next: PlanRevision): PlanDiff {
  return {
    seq: next.seq,
    againstSeq: prev.seq,
    parts: diffParts(prev.parts, next.parts),
    narrative: diffNarrative(prev.narrative, next.narrative),
  };
}

/**
 * Parts, keyed on slug — which is the merge key ingestion itself uses, so this
 * reading and the store's cannot disagree about what "the same part" is.
 *
 * Order follows the *new* declaration, with dropped parts appended: the list is
 * read as "here is the plan now, and here is what left it", and interleaving a
 * dropped part at its old index would put a row in the sequence that no longer has
 * one.
 */
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

/**
 * The declared fields worth showing a difference in.
 *
 * `seq` is deliberately not one of them. It moves whenever anything is inserted
 * above a part, so including it would mark half a decomposition as changed every
 * time one part was added — the noise that makes a diff stop being read.
 */
function changedFields(prev: PlanPartInput, next: PlanPartInput): FieldChange[] {
  const out: FieldChange[] = [];
  const compare = (field: string, from: string | null, to: string | null): void => {
    if (from !== to) out.push({ field, from, to });
  };
  compare('title', prev.title, next.title);
  compare('scope', prev.scope, next.scope);
  compare('touches', listOf(prev.touches), listOf(next.touches));
  // Order is not a difference: `dependsOn` is a set to the scheduler, and a
  // re-ordered rejoin means nothing to anybody.
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

/**
 * Which plan-level fields moved — **named, never diffed word by word.**
 *
 * A planner rewrites a paragraph wholesale rather than editing it, so a word-level
 * diff of one is two paragraphs marked entirely changed: all noise, no signal. The
 * fact worth carrying is which of them the amendment touched, and the sheet then
 * shows the new text, which is the one a decision is made on.
 */
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

/** One narrative field as comparable text. `evidence` folds to its citations, in order. */
function narrativeText(narrative: PlanNarrative, field: keyof PlanNarrative): string | null {
  if (field === 'evidence') {
    if (narrative.evidence.length === 0) return null;
    return narrative.evidence.map((e) => `${e.path}:${e.line ?? ''}:${e.note ?? ''}`).join('\n');
  }
  return narrative[field];
}
