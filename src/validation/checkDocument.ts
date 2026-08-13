import { z } from 'zod';
import type { ValidationCheckInput, ValidationResourceInput } from '../types.js';

/**
 * The `validation` block of a plan document: how anyone checks the *goal* was
 * met, as steps rather than as a paragraph.
 *
 * `verification` — one optional narrative field, "how anyone will know the whole
 * thing worked" — is read once while deciding whether to approve, and nothing
 * ever runs it. This is that field's executable form.
 *
 * Additive and **optional** on the plan document, for the reason every post-v1
 * field is: an older plan, and an operator override that never learned the block,
 * must keep validating.
 */

/** How many checks are kept. Trimmed rather than refused, `MAX_EVIDENCE`'s trade. */
const MAX_CHECKS = 40;

/** Same bound, same argument, for the resources they name. */
const MAX_RESOURCES = 20;

const ResourceSchema = z.object({
  /**
   * A file name, and only a file name. Refused rather than sanitised, because
   * this is the string `validationResourcePath` joins onto the goal's directory:
   * a name carrying a separator or a `..` would resolve outside
   * `validationRoot`, and a planner is an agent authoring a path the harness then
   * resolves for a person. A refusal is returned to it and fixable; a quiet
   * `basename` would silently rename the thing the check asks for.
   */
  name: z
    .string()
    .min(1)
    .regex(/^[^/\\]+$/, 'a resource name is a file name, not a path')
    .refine((name) => name !== '.' && name !== '..', 'a resource name is a file name, not a path'),
  /**
   * Refused rather than widened when it is a word this does not know, the same
   * treatment `size` and `expectedKind` get: the value is rendered as a label, so
   * an unrecognised one is a chip nobody can read. Absent is always allowed.
   */
  kind: z.enum(['fixture', 'access', 'reference', 'data']).optional(),
  note: z.string().min(1).optional(),
  /** Default true. False is "I need this and cannot produce it" — ingestion files the ask. */
  provided: z.boolean().default(true),
});

const CheckSchema = z
  .object({
    /** Stable and author-chosen: an amendment merges on it, so it must survive a replan. */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: z.string().min(1),
    do: z.string().min(1),
    expect: z.string().min(1),
    /** Declared resource **names**, never paths. An unknown name is dropped at ingestion. */
    uses: z.array(z.string().min(1)).default([]),
    /** Part slugs this check exercises. Unknown slugs are dropped the same way. */
    covers: z.array(z.string().min(1)).default([]),
    /** The planner's nomination that an agent could run this. Dispatches nothing. */
    fleetCandidate: z.boolean().default(false),
    why: z.string().min(1).optional(),
  })
  // Strict, where the rest of the plan document is tolerant, and `actor` is the
  // whole reason. A field this schema quietly dropped would let a planner believe
  // it had assigned a check to the fleet; refusing says so, and both transports
  // hand the reason straight back to an agent that can fix it and call again.
  .strict('a check declares only id/title/do/expect/uses/covers/fleetCandidate/why — who runs it is not yours to say');

/**
 * Reached by **both** transports exactly as `PlanDocumentSchema` is — the
 * `plan.json` drain and the `plan_submit` tool must accept and reject the same
 * documents.
 *
 * The one refusal worth stating on its own: **there is no `actor` field**, and a
 * document carrying one is refused rather than ignored. Whether an agent can run
 * a check is a property of the deployment — the fleet has no browser, no
 * interactive login and no account on whatever environment this deployment tests
 * against — and a planner reading the repository can know none of that. Silently
 * dropping the field would let one believe it had assigned work.
 */
export const ValidationSchema = z
  .object({
    resources: z
      .array(ResourceSchema)
      .default([])
      .transform((list) => (list.length > MAX_RESOURCES ? list.slice(0, MAX_RESOURCES) : list)),
    checks: z
      .array(CheckSchema)
      .default([])
      .transform((list) => (list.length > MAX_CHECKS ? list.slice(0, MAX_CHECKS) : list)),
  })
  .strict('a validation block declares only "resources" and "checks"')
  .superRefine((block, ctx) => {
    const ids = new Set<string>();
    for (const check of block.checks) {
      if (ids.has(check.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checks'], message: `duplicate check id "${check.id}"` });
      ids.add(check.id);
    }
    const names = new Set<string>();
    for (const resource of block.resources) {
      if (names.has(resource.name))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resources'],
          message: `duplicate resource "${resource.name}"`,
        });
      names.add(resource.name);
    }
  });

type ValidationBlock = z.infer<typeof ValidationSchema>;

/**
 * The declared checks as store input, sequenced by their order in the document
 * and with their bibliographies pruned.
 *
 * `uses` and `covers` are **dropped entry by entry** rather than refused, the
 * `MAX_EVIDENCE` trade-off: a check's prose is worth more than its references,
 * and a planner that named a resource it forgot to declare has still written a
 * runnable check. A refusal here would sink the whole plan document with it.
 */
export function validationCheckInputs(block: ValidationBlock, partSlugs: readonly string[]): ValidationCheckInput[] {
  const names = new Set(block.resources.map((r) => r.name));
  const slugs = new Set(partSlugs);
  return block.checks.map((check, index) => ({
    id: check.id,
    seq: index + 1,
    title: check.title,
    do: check.do,
    expect: check.expect,
    uses: check.uses.filter((name) => names.has(name)),
    covers: check.covers.filter((slug) => slugs.has(slug)),
    fleetCandidate: check.fleetCandidate,
    // Only ever the reason for a nomination, so it is dropped with one. A "why an
    // agent could run this" left standing beside `fleetCandidate: false` reads as
    // a nomination the sheet is failing to draw.
    candidateWhy: check.fleetCandidate ? (check.why ?? null) : null,
  }));
}

/** The declared resources as store input. */
export function validationResourceInputs(block: ValidationBlock): ValidationResourceInput[] {
  return block.resources.map((resource) => ({
    name: resource.name,
    kind: resource.kind ?? null,
    note: resource.note ?? null,
    provided: resource.provided,
  }));
}

/**
 * The next unused check letter: `A`…`Z`, then `AA`, `AB`… Pure.
 *
 * Letters are handed out at ingestion and **never reused**, which is why this
 * takes every letter a plan has ever issued rather than a count. A check dropped
 * by an amendment keeps its row (superseded), so its letter stays taken — and
 * `284:C` names one check for the life of the goal instead of moving under the
 * next replan. Deriving a letter from position compiles, passes and silently
 * misaddresses.
 */
export function nextCheckLetter(taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 0; ; n += 1) {
    const letter = letterAt(n);
    if (!used.has(letter)) return letter;
  }
}

/** Bijective base-26: 0 => A, 25 => Z, 26 => AA. */
function letterAt(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
