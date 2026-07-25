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
});

/**
 * Validated at the boundary like every other agent-authored payload (see
 * `src/dispatcher/actions.ts`). The structural checks below are integrity, not
 * scheduling: unique slugs and resolvable, non-self dependencies are what make the
 * persisted graph meaningful at all. Dependency *ordering* — readiness, base
 * selection, the at-most-one-open-dependency rule — belongs to the scheduler.
 */
export const PlanDocumentSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum(['single', 'parts']),
    reason: z.string().min(1),
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
  });

export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

/** A parsed plan document, or the reason it was rejected. Never throws. */
export type PlanParseResult = { ok: true; document: PlanDocument } | { ok: false; error: string };

/** Parse and validate a raw `plan.json` body. Pure. */
export function parsePlanDocument(raw: string): PlanParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }
  const result = PlanDocumentSchema.safeParse(json);
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
  }));
}
