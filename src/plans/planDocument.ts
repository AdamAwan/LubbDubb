import { z } from 'zod';
import { ValidationSchema } from '../validation/checkDocument.js';
import type { PlanNarrative, PlanPartInput } from '../types.js';

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

/**
 * How many citations are kept. A planner asked for evidence occasionally answers
 * with a file listing; trimmed rather than refused, for {@link
 * MAX_PLAN_DOCUMENT_CHARS}'s reason — the verdict must not be sunk by its
 * footnotes.
 */
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
   * The same ownership claim as paths. Beside `scope` rather than replacing it:
   * only this form can be compared to what the part's agent actually wrote, and
   * only the prose form survives work whose scope is not a set of files.
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
   * What this part produces. Optional, and defaulted at *read* time rather than
   * here: an older plan, and an operator override that never learned the field,
   * must keep validating — and `code` is the assumption everything else already
   * made. `determination` is what lets a planner decompose investigative work
   * honestly instead of inventing a pull request for it.
   *
   * `human` is the step no agent runs: a person flips the setting in a console
   * nobody gave the fleet an account for, plugs the thing in, or looks at the
   * rendered screen and says whether it is right. Ingestion backs such a part
   * with a `human_tasks` row and rule `plan-part` never dispatches it, so a
   * sibling naming it in `dependsOn` waits for a person exactly the way it would
   * otherwise wait for a merge — no second blocking mechanism, and none needed.
   */
  expectedKind: z.enum(['code', 'report', 'determination', 'human']).optional(),
  /**
   * The model profile this part's own work should run on (issue #342). Absent
   * means the planner did not single this part out, and it inherits the goal's
   * pin — which is what most parts should do, and what every plan written before
   * this existed does.
   *
   * Not enumerated here, for {@link expectedKind}'s reason pointed at a different
   * problem: the valid names are the operator's `agentModels.profiles`, which
   * this schema cannot see, and an override template or an older plan naming a
   * profile since renamed must still validate rather than failing a whole
   * decomposition over one word. An unrecognised name falls through to the
   * goal's pin at dispatch (`resolveAgentProfile`), which is the same place a
   * mistyped tag lands.
   */
  profile: z.string().min(1).optional(),
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
    reason: z.string().min(1),
    /**
     * The root cause, and what is going to be done about it. Optional for the
     * reason every field added after v1 is: an older plan, and an operator
     * override that never learned them, must keep validating — the alternative is
     * a schema bump that fails every submission from a customised deployment.
     *
     * Separate from {@link reason} rather than folded into it because they answer
     * different questions, and the field that had to answer all three answered
     * whichever one the planner reached for. `diagnosis` is also legitimately
     * absent on work that is not a defect; `approach` is not.
     */
    diagnosis: z.string().min(1).optional(),
    approach: z.string().min(1).optional(),
    /** What could go wrong with this split. */
    risks: z.string().min(1).optional(),
    /** What the planner deliberately left out. */
    outOfScope: z.string().min(1).optional(),
    /**
     * What was considered and rejected, what the planner is least sure about, and
     * how anyone will know the whole thing worked.
     *
     * All three were already asked for — inside `document`, where they are prose in
     * a write-up nobody opens while deciding. As fields they can be put in front of
     * the verdict, and `openQuestions` can be what a discussion opens on.
     */
    alternatives: z.string().min(1).optional(),
    openQuestions: z.string().min(1).optional(),
    verification: z.string().min(1).optional(),
    /**
     * Where in the code the diagnosis comes from. Trimmed to {@link MAX_EVIDENCE}
     * rather than refused, like the write-up: a plan is not worth rejecting over
     * the length of its footnotes.
     */
    evidence: z
      .array(EvidenceSchema)
      .default([])
      .transform((list) => (list.length > MAX_EVIDENCE ? list.slice(0, MAX_EVIDENCE) : list)),
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
    /**
     * How anyone checks the *goal* was met, as steps rather than as a paragraph —
     * {@link verification}'s executable form. Optional for the reason every field
     * added after v1 is. A goal delivered as one part needs validating exactly as
     * much as one delivered as eight.
     * → `src/validation/checkDocument.ts`
     */
    validation: ValidationSchema.optional(),
  })
  .superRefine((doc, ctx) => {
    // **Every plan declares parts**, and that is the whole shape of the schema:
    // there is no `single` verdict beside a `parts` one, because a goal delivered
    // as one pull request is a plan with one part and nothing else about it is
    // different. The verdict field it replaced encoded "one PR" as *zero parts*,
    // which made the commonest plan the one with no rows — no branch of its own,
    // no acceptance criteria, no scope to drift from, and a second scheduling path
    // (rule `issue-pickup` on the flat `issue/<n>` branch) for every consumer to
    // remember. A document still carrying `verdict` is not refused for carrying it
    // — zod strips it — but one carrying no parts is, with the sentence below, so
    // an operator override written against the old shape is corrected on its first
    // submission rather than silently accepted as something else.
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
    // `dependsOn` is deliberately *not* capped at one entry (issue #170). The cap was
    // the static form of "a part may stack on at most one *open* dependency", and that
    // rule is real — but it does not bite on a rejoin, where several prerequisites all
    // have to have settled before the part starts, leaving nothing open and the
    // integration branch as the unambiguous base. The dangerous case is refused
    // dynamically instead, by `PlanReconciler.readiness`, which is the only place that
    // can see whether a dependency is still in flight *now*.
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
    // A cycle deadlocks every part in it — none is ever ready, and the issue
    // silently stops progressing. Reject the document instead: the planner is
    // retried and eventually fails the issue open to unplanned pickup.
    const cycle = findDependencyCycle(doc.parts);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parts'],
        message: `dependency cycle: ${cycle.join(' -> ')}`,
      });
    }
  });

/**
 * The slugs of one dependency cycle, or null when the graph is acyclic.
 *
 * A depth-first walk over **every** edge, not down a single chain. While arity was
 * capped at one a chain walk was the whole graph; the moment a part may name several
 * prerequisites (issue #170) a cycle reachable only through the second one — `a`
 * depends on `[x, b]`, `b` on `[a]` — is a cycle a chain walk cannot see, and one
 * that survives ingestion deadlocks every part in it silently.
 */
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
 * row carries.
 *
 * One function so the two writes cannot disagree about what "the narrative" is:
 * {@link ingestPlanDocument} passes it to `upsertPlan` and to `recordPlanRevision`
 * in the same breath, and a field added to the document reaches both or neither.
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
