import { z } from 'zod';
import { ValidationSchema } from '../validation/checkDocument.js';
import { WatchSchema } from '../validation/watchDocument.js';
import type { PlanNarrative, PlanPartInput } from '../types.js';

/**
 * The planner's side channel: `.lubbdubb/plan.json`, written into its worktree.
 * The file-events `PostToolUse` hook already reports every written path, so a
 * reserved filename is the whole protocol (a sentinel would bump into
 * `MAX_SENTINEL_HOLD`). `.lubbdubb/` is gitignored: the plan graph lives only in
 * the store, never as a committed artefact.
 */
export const PLAN_FILE = '.lubbdubb/plan.json';

/** Does a worktree-relative write path name the reserved plan file? */
export function isPlanFile(path: string): boolean {
  return path.replace(/\\/g, '/') === PLAN_FILE;
}

/**
 * How much narrative is kept. Trimmed rather than refused (see the test): the
 * write-up rides along with a verdict, so rejecting it for length would throw
 * away the decomposition too.
 */
export const MAX_PLAN_DOCUMENT_CHARS = 60_000;

/** How many citations are kept. Trimmed rather than refused, as the write-up is. */
const MAX_EVIDENCE = 24;

/** Same bound, same argument, for a part's declared paths. */
const MAX_TOUCHES = 40;

const EvidenceSchema = z.object({
  path: z.string().min(1),
  /** Optional because a claim is often about a file; a planner made to invent a line would. */
  line: z.number().int().positive().optional(),
  note: z.string().min(1).optional(),
});

const PartSchema = z.object({
  /** Stable and author-chosen: an amended plan merges on it, so it must survive a replan. */
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
  title: z.string().min(1),
  /** Files/areas this part owns — what substitutes for a human holding the split in their head. */
  scope: z.string().min(1),
  /**
   * The same ownership claim as paths, beside `scope` rather than replacing it:
   * only this form can be compared to what the part's agent actually wrote.
   */
  touches: z.array(z.string().min(1)).max(MAX_TOUCHES).default([]),
  /** How big this part is to review. Absent means the planner did not say. */
  size: z.enum(['s', 'm', 'l']).optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  /** Why this is its *own* PR rather than folded into a sibling. */
  rationale: z.string().min(1).optional(),
  /** What makes this part done. */
  acceptance: z.string().min(1).optional(),
  /**
   * What this part produces. Optional, defaulted to `code` at read time so an
   * older plan still validates. `human` is a step no agent runs — backed by a
   * `human_tasks` row, never dispatched, so a sibling depending on it waits for a
   * person the way it would wait for a merge.
   */
  expectedKind: z.enum(['code', 'report', 'determination', 'human']).optional(),
  /** The model profile this part runs on. Absent inherits the goal's pin. Not enumerated — validated names live in `agentModels.profiles`, unseen here. */
  profile: z.string().min(1).optional(),
});

/**
 * Validated at the boundary like every other agent-authored payload. The checks
 * below are integrity only — unique slugs, resolvable non-self dependencies;
 * dependency *ordering* and readiness belong to the scheduler.
 */
const PlanDocumentSchema = z
  .object({
    version: z.literal(1),
    reason: z.string().min(1),
    /** The root cause, and what is going to be done about it. Optional, like every field added after v1, so an older plan still validates. */
    diagnosis: z.string().min(1).optional(),
    approach: z.string().min(1).optional(),
    /** What could go wrong with this split. */
    risks: z.string().min(1).optional(),
    /** What the planner deliberately left out. */
    outOfScope: z.string().min(1).optional(),
    /** What was considered and rejected, least sure about, and how anyone will know it worked — fields, not prose in `document`, so they can front the verdict. */
    alternatives: z.string().min(1).optional(),
    openQuestions: z.string().min(1).optional(),
    verification: z.string().min(1).optional(),
    /** Where in the code the diagnosis comes from. Trimmed to {@link MAX_EVIDENCE}, never refused. */
    evidence: z
      .array(EvidenceSchema)
      .default([])
      .transform((list) => (list.length > MAX_EVIDENCE ? list.slice(0, MAX_EVIDENCE) : list)),
    /** The full narrative, markdown. Stored on the plan row, never as an artifact chip — those serve from the worktree, removed on reap, so it would 404 exactly when ready to approve. */
    document: z
      .string()
      .min(1)
      .transform((s) => (s.length > MAX_PLAN_DOCUMENT_CHARS ? s.slice(0, MAX_PLAN_DOCUMENT_CHARS) : s))
      .optional(),
    parts: z.array(PartSchema).default([]),
    /** How anyone checks the goal was met, as steps — {@link verification}'s executable form. → `src/validation/checkDocument.ts` */
    validation: ValidationSchema.optional(),
    /** What a deployed system would have to show for this work to have done what it claimed — the layer above `validation`. A goal with no checks reads null, never clean. → `src/validation/watchDocument.ts` */
    watch: WatchSchema.optional(),
  })
  .superRefine((doc, ctx) => {
    // Every plan declares parts, so there is no second scheduling path; zero parts is refused.
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
    // dependsOn is not capped at one: "at most one open dependency" is enforced dynamically by PlanReconciler.readiness.
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
    // A cycle deadlocks every part in it — none is ever ready. Reject instead; the planner retries and eventually fails open to unplanned pickup.
    const cycle = findDependencyCycle(doc.parts);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parts'],
        message: `dependency cycle: ${cycle.join(' -> ')}`,
      });
    }
  });

/** The slugs of one dependency cycle, or null when acyclic. Walks every edge, not one chain, so a cycle reachable only through a second dependency is still caught. */
function findDependencyCycle(parts: { slug: string; dependsOn: string[] }[]): string[] | null {
  const deps = new Map(parts.map((p) => [p.slug, p.dependsOn]));
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];
  const walk = (slug: string): string[] | null => {
    if (settled.has(slug) || !deps.has(slug)) return null; // done, or names an unknown part (reported above)
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

export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

/** A parsed plan document, or the reason it was rejected. Never throws. */
type PlanParseResult = { ok: true; document: PlanDocument } | { ok: false; error: string };

/** Parse and validate a raw `plan.json` body. Pure. */
export function parsePlanDocument(raw: string): PlanParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }
  return validatePlanDocument(json);
}

/**
 * Validate an already-decoded document — the entry point for the `plan_submit`
 * MCP tool, whose arguments the client already parsed. Both transports must reach
 * this same schema.
 */
export function validatePlanDocument(value: unknown): PlanParseResult {
  const result = PlanDocumentSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, document: result.data };
}

/** The declared parts as store input, sequenced by their order in the document. */
export function planPartInputs(doc: PlanDocument): PlanPartInput[] {
  return doc.parts.map((part, index) => ({
    slug: part.slug,
    seq: index + 1,
    title: part.title,
    scope: part.scope,
    touches: part.touches,
    dependsOn: part.dependsOn,
    rationale: part.rationale ?? null,
    acceptance: part.acceptance ?? null,
    size: part.size ?? null,
    expectedKind: part.expectedKind ?? null,
    profile: part.profile ?? null,
  }));
}

/**
 * The plan-level prose of a document, as the shape a revision stores and the plan
 * row carries. One function so `upsertPlan` and `recordPlanRevision` cannot
 * disagree about what "the narrative" is.
 */
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
