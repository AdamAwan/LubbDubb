import { z } from 'zod';
import { ValidationSchema } from '../validation/checkDocument.js';
import { WatchSchema } from '../validation/watchDocument.js';
import type { PlanAtomInput, PlanNarrative, PlanPartInput } from '../types.js';

// → docs/spec/08-planning.md

export const PLAN_FILE = '.lubbdubb/plan.json';

export function isPlanFile(path: string): boolean {
  return path.replace(/\\/g, '/') === PLAN_FILE;
}

export const MAX_PLAN_DOCUMENT_CHARS = 60_000;

const MAX_EVIDENCE = 24;

const MAX_TOUCHES = 40;

const EvidenceSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  note: z.string().min(1).optional(),
});

const MAX_REJECTED = 8;

const RejectedSchema = z.object({
  route: z.string().min(1),
  because: z.string().min(1),
});

const AtomSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
  title: z.string().min(1),
  intent: z.string().min(1),
  touches: z.array(z.string().min(1)).max(MAX_TOUCHES).default([]),
  acceptance: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  rejected: z
    .array(RejectedSchema)
    .default([])
    .transform((list) => (list.length > MAX_REJECTED ? list.slice(0, MAX_REJECTED) : list)),
});

const PartSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
  title: z.string().min(1),
  scope: z.string().min(1),
  touches: z.array(z.string().min(1)).max(MAX_TOUCHES).default([]),
  atoms: z.array(z.string().min(1)).default([]),
  size: z.enum(['s', 'm', 'l']).optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1).optional(),
  acceptance: z.string().min(1).optional(),
  expectedKind: z.enum(['code', 'report', 'determination', 'human']).optional(),
  profile: z.string().min(1).optional(),
});

const PlanDocumentSchema = z
  .object({
    version: z.literal(1),
    reason: z.string().min(1),
    diagnosis: z.string().min(1).optional(),
    approach: z.string().min(1).optional(),
    risks: z.string().min(1).optional(),
    outOfScope: z.string().min(1).optional(),
    alternatives: z.string().min(1).optional(),
    openQuestions: z.string().min(1).optional(),
    verification: z.string().min(1).optional(),
    evidence: z
      .array(EvidenceSchema)
      .default([])
      .transform((list) => (list.length > MAX_EVIDENCE ? list.slice(0, MAX_EVIDENCE) : list)),
    document: z
      .string()
      .min(1)
      .transform((s) => (s.length > MAX_PLAN_DOCUMENT_CHARS ? s.slice(0, MAX_PLAN_DOCUMENT_CHARS) : s))
      .optional(),
    atoms: z.array(AtomSchema).default([]),
    parts: z.array(PartSchema).default([]),
    validation: ValidationSchema.optional(),
    watch: WatchSchema.optional(),
  })
  .superRefine((doc, ctx) => {
    if (doc.parts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parts'],
        message: 'a plan needs at least one part — work that is one pull request is a plan with one part',
      });
      return;
    }
    const slugs = new Set<string>();
    for (const part of doc.parts) {
      if (slugs.has(part.slug)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['parts'], message: `duplicate slug "${part.slug}"` });
      }
      slugs.add(part.slug);
    }
    for (const part of doc.parts) {
      for (const dep of part.dependsOn) {
        if (dep === part.slug) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['parts'], message: `"${part.slug}" depends on itself` });
        } else if (!slugs.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parts'],
            message: `"${part.slug}" depends on unknown part "${dep}"`,
          });
        }
      }
    }
    const cycle = findDependencyCycle(doc.parts);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parts'],
        message: `dependency cycle: ${cycle.join(' -> ')}`,
      });
    }
    refineAtoms(doc, ctx);
  });

function refineAtoms(doc: { atoms: AtomInput[]; parts: { slug: string; atoms: string[] }[] }, ctx: z.RefinementCtx) {
  const refuse = (message: string, path: 'atoms' | 'parts' = 'atoms'): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  const known = new Set<string>();
  for (const atom of doc.atoms) {
    if (known.has(atom.slug)) refuse(`duplicate atom "${atom.slug}"`);
    known.add(atom.slug);
  }
  for (const atom of doc.atoms) {
    for (const dep of atom.dependsOn) {
      if (dep === atom.slug) refuse(`atom "${atom.slug}" depends on itself`);
      else if (!known.has(dep)) refuse(`atom "${atom.slug}" depends on unknown atom "${dep}"`);
    }
  }

  const carriers = new Map<string, string[]>();
  for (const part of doc.parts) {
    for (const slug of part.atoms) {
      if (!known.has(slug)) {
        refuse(`part "${part.slug}" carries unknown atom "${slug}"`, 'parts');
        continue;
      }
      carriers.set(slug, [...(carriers.get(slug) ?? []), part.slug]);
    }
  }
  for (const atom of doc.atoms) {
    const holders = carriers.get(atom.slug) ?? [];
    if (holders.length === 0) {
      refuse(`atom "${atom.slug}" is carried by no part — nobody is scheduled to do it`);
    } else if (holders.length > 1) {
      refuse(
        `atom "${atom.slug}" is carried by ${holders.map((s) => `"${s}"`).join(' and ')} — one atom, one part`,
        'parts',
      );
    }
  }

  const partOf = new Map<string, string>(
    [...carriers].flatMap(([slug, holders]) => (holders.length === 1 ? [[slug, holders[0]] as [string, string]] : [])),
  );
  const induced = inducedPartCycle(doc.atoms, partOf);
  if (induced) {
    refuse(
      `atom "${induced.atom}" depends on "${induced.dep}", which puts parts "${induced.from}" and "${induced.to}" ` +
        `in a cycle: ${induced.path.join(' -> ')}`,
      'parts',
    );
  }
}

interface InducedCycle {
  atom: string;
  dep: string;
  from: string;
  to: string;
  path: string[];
}

function inducedPartCycle(atoms: AtomInput[], partOf: Map<string, string>): InducedCycle | null {
  const edges = new Map<string, { to: string; atom: string; dep: string }[]>();
  for (const atom of atoms) {
    const from = partOf.get(atom.slug);
    if (from === undefined) continue;
    for (const dep of atom.dependsOn) {
      const to = partOf.get(dep);
      if (to === undefined || to === from) continue;
      edges.set(from, [...(edges.get(from) ?? []), { to, atom: atom.slug, dep }]);
    }
  }
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];
  const walk = (part: string): InducedCycle | null => {
    if (settled.has(part)) return null;
    onPath.add(part);
    path.push(part);
    for (const edge of edges.get(part) ?? []) {
      if (onPath.has(edge.to)) {
        return {
          atom: edge.atom,
          dep: edge.dep,
          from: part,
          to: edge.to,
          path: [...path.slice(path.indexOf(edge.to)), edge.to],
        };
      }
      const found = walk(edge.to);
      if (found) return found;
    }
    onPath.delete(part);
    path.pop();
    settled.add(part);
    return null;
  };
  for (const start of edges.keys()) {
    const found = walk(start);
    if (found) return found;
  }
  return null;
}

function findDependencyCycle(parts: { slug: string; dependsOn: string[] }[]): string[] | null {
  const deps = new Map(parts.map((p) => [p.slug, p.dependsOn]));
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];
  const walk = (slug: string): string[] | null => {
    if (settled.has(slug) || !deps.has(slug)) return null;
    if (onPath.has(slug)) return [...path.slice(path.indexOf(slug)), slug];
    onPath.add(slug);
    path.push(slug);
    for (const dep of deps.get(slug) ?? []) {
      const cycle = walk(dep);
      if (cycle) return cycle;
    }
    onPath.delete(slug);
    path.pop();
    settled.add(slug);
    return null;
  };
  for (const start of deps.keys()) {
    const cycle = walk(start);
    if (cycle) return cycle;
  }
  return null;
}

type AtomInput = z.infer<typeof AtomSchema>;

export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

type PlanParseResult = { ok: true; document: PlanDocument } | { ok: false; error: string };

export function parsePlanDocument(raw: string): PlanParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }
  return validatePlanDocument(json);
}

export function validatePlanDocument(value: unknown): PlanParseResult {
  const result = PlanDocumentSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, document: result.data };
}

export function planPartInputs(doc: PlanDocument): PlanPartInput[] {
  return doc.parts.map((part, index) => ({
    slug: part.slug,
    seq: index + 1,
    title: part.title,
    scope: part.scope,
    touches: part.touches.length > 0 ? part.touches : atomTouches(doc, part.atoms),
    atoms: part.atoms,
    dependsOn: part.dependsOn,
    rationale: part.rationale ?? null,
    acceptance: part.acceptance ?? null,
    size: part.size ?? null,
    expectedKind: part.expectedKind ?? null,
    profile: part.profile ?? null,
  }));
}

export function planAtomInputs(doc: PlanDocument): PlanAtomInput[] {
  return doc.atoms.map((atom, index) => ({
    slug: atom.slug,
    seq: index + 1,
    title: atom.title,
    intent: atom.intent,
    touches: atom.touches,
    acceptance: atom.acceptance ?? null,
    dependsOn: atom.dependsOn,
    rejected: atom.rejected,
  }));
}

function atomTouches(doc: PlanDocument, slugs: string[]): string[] {
  const carried = new Set(slugs);
  const paths = new Set(doc.atoms.filter((a) => carried.has(a.slug)).flatMap((a) => a.touches));
  return [...paths].slice(0, MAX_TOUCHES);
}

export function planNarrative(doc: PlanDocument): PlanNarrative {
  return {
    reason: doc.reason,
    diagnosis: doc.diagnosis ?? null,
    approach: doc.approach ?? null,
    risks: doc.risks ?? null,
    outOfScope: doc.outOfScope ?? null,
    alternatives: doc.alternatives ?? null,
    openQuestions: doc.openQuestions ?? null,
    verification: doc.verification ?? null,
    document: doc.document ?? null,
    evidence: doc.evidence.map((e) => ({ path: e.path, line: e.line ?? null, note: e.note ?? null })),
  };
}
