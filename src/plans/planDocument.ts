import { z } from 'zod';
import type { PlanPartInput } from '../types.js';

/**
 * The planner's side channel: `.lubbdubb/plan.json`, written into its worktree.
 *
 * There is no new sentinel and no network coupling from the agent to the server —
 * the file-events `PostToolUse` hook already reports every written path, so a
 * reserved filename is all the protocol needed. (A `@@LUBBDUBB_PLAN:<json>@@`
 * sentinel would be more consistent, but a real plan bumps into `MAX_SENTINEL_HOLD`.)
 *
 * `.lubbdubb/` is gitignored, so this is deliberately *not* a committed artefact:
 * the plan graph lives only in the store, which is the cost the design's "Why
 * local" section already accepts.
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

const PartSchema = z.object({
  /** Stable and author-chosen: an amended plan merges on it, so it must survive a replan. */
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
  title: z.string().min(1),
  /** Files/areas this part owns — what substitutes for a human holding the split in their head. */
  scope: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  /** Why this is its *own* PR rather than folded into a sibling. */
  rationale: z.string().min(1).optional(),
  /** What makes this part done. */
  acceptance: z.string().min(1).optional(),
});

/**
 * Validated at the boundary like every other agent-authored payload (see
 * `src/dispatcher/actions.ts`). The structural checks below are integrity, not
 * scheduling: unique slugs and resolvable, non-self dependencies are what make the
 * persisted graph meaningful at all. Dependency *ordering* — readiness, base
 * selection, the at-most-one-open-dependency rule — belongs to the scheduler.
 */
const PlanDocumentSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum(['single', 'parts']),
    reason: z.string().min(1),
    /** What could go wrong with this split. */
    risks: z.string().min(1).optional(),
    /** What the planner deliberately left out. */
    outOfScope: z.string().min(1).optional(),
    /**
     * The full narrative, markdown. Stored on the plan row rather than surfaced
     * as an artifact chip: `GET /artifacts/:id` serves out of the agent's
     * worktree, and `system.ts` removes that worktree on a `done` reap — so a
     * write-up surfaced that way 404s exactly when the plan is ready to approve.
     * Trimmed rather than refused for the same reason `MAX_PLAN_DOCUMENT_CHARS`
     * exists at all — an over-long write-up must not sink the whole submission.
     */
    document: z
      .string()
      .min(1)
      .transform((s) => (s.length > MAX_PLAN_DOCUMENT_CHARS ? s.slice(0, MAX_PLAN_DOCUMENT_CHARS) : s))
      .optional(),
    parts: z.array(PartSchema).default([]),
  })
  .superRefine((doc, ctx) => {
    if (doc.verdict === 'single') return; // parts are ignored on a single verdict
    if (doc.parts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parts'],
        message: 'a "parts" verdict needs at least one part',
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
      // The static form of "a part may stack on at most one *open* dependency":
      // with two declared dependencies both can be in review at the same moment
      // and there is no single branch to base the part on. Multi-parent merge
      // bases aren't worth the complexity, so the constraint is enforced here
      // rather than discovered at dispatch, where the plan is already persisted.
      if (part.dependsOn.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parts'],
          message: `"${part.slug}" declares ${part.dependsOn.length} dependencies; a part may stack on at most one`,
        });
      }
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
    // A cycle deadlocks every part in it — none is ever ready, and the issue
    // silently stops progressing. Reject the document instead: the planner is
    // retried and eventually fails the issue open to `single`.
    const cycle = findDependencyCycle(doc.parts);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parts'],
        message: `dependency cycle: ${cycle.join(' -> ')}`,
      });
    }
  });

/** The slugs of one dependency cycle, or null when the graph is acyclic. */
function findDependencyCycle(parts: { slug: string; dependsOn: string[] }[]): string[] | null {
  const deps = new Map(parts.map((p) => [p.slug, p.dependsOn]));
  const settled = new Set<string>();
  for (const start of deps.keys()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && deps.has(current) && !settled.has(current)) {
      if (onPath.has(current)) return [...path.slice(path.indexOf(current)), current];
      path.push(current);
      onPath.add(current);
      current = deps.get(current)?.[0];
    }
    for (const slug of path) settled.add(slug);
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
 * Validate an already-decoded document. The `plan_submit` MCP tool arrives with
 * arguments the client already parsed, so it enters here rather than through
 * {@link parsePlanDocument} — but both reach the same schema, which is the point:
 * the two transports must accept and reject exactly the same plans.
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
    dependsOn: part.dependsOn,
    rationale: part.rationale ?? null,
    acceptance: part.acceptance ?? null,
  }));
}
