import { z } from 'zod';
import type { ValidationCheckAmendment, ValidationCheckInput, ValidationResourceInput } from '../types.js';

// → docs/spec/20-validation.md

const MAX_CHECKS = 40;

const MAX_RESOURCES = 20;

export const ValidationResourceSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[^/\\]+$/, 'a resource name is a file name, not a path')
    .refine((name) => name !== '.' && name !== '..', 'a resource name is a file name, not a path'),
  kind: z.enum(['fixture', 'access', 'reference', 'data']).optional(),
  note: z.string().min(1).optional(),
  provided: z.boolean().default(true),
});

export const ValidationCheckSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: z.string().min(1),
    do: z.string().min(1),
    expect: z.string().min(1),
    uses: z.array(z.string().min(1)).default([]),
    covers: z.array(z.string().min(1)).default([]),
    fleetCandidate: z.boolean().default(false),
    why: z.string().min(1).optional(),
  })
  .strict('a check declares only id/title/do/expect/uses/covers/fleetCandidate/why — who runs it is not yours to say');

export const ValidationSchema = z
  .object({
    hint: z.string().min(1).optional(),
    resources: z
      .array(ValidationResourceSchema)
      .optional()
      .transform((list) => (list !== undefined && list.length > MAX_RESOURCES ? list.slice(0, MAX_RESOURCES) : list)),
    checks: z
      .array(ValidationCheckSchema)
      .optional()
      .transform((list) => (list !== undefined && list.length > MAX_CHECKS ? list.slice(0, MAX_CHECKS) : list)),
  })
  .strict(
    'a validation block declares only "hint", and — from a plan written before the hint — "resources" and "checks"',
  )
  .superRefine((block, ctx) => {
    const ids = new Set<string>();
    for (const check of block.checks ?? []) {
      if (ids.has(check.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checks'], message: `duplicate check id "${check.id}"` });
      ids.add(check.id);
    }
    const names = new Set<string>();
    for (const resource of block.resources ?? []) {
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

type DeclaredCheck = z.infer<typeof ValidationCheckSchema>;

type DeclaredResource = z.infer<typeof ValidationResourceSchema>;

/** The parts a check's `covers` is resolved against: their slugs, and the area each one covers. */
interface CoveredPart {
  slug: string;
  coverage: string | null;
}

/**
 * A plan document's own check set — the **legacy** shape, and the reason it survives. The check set
 * is authored after delivery now ([20](../../docs/spec/20-validation.md#when-the-check-set-is-written)),
 * but a plan carrying `checks` was ingested into rows an operator may be halfway through, and
 * re-reading such a document as a hint would delete them.
 */
export function validationCheckInputs(block: ValidationBlock, parts: readonly CoveredPart[]): ValidationCheckInput[] {
  const names = new Set((block.resources ?? []).map((r) => r.name));
  return (block.checks ?? []).map((check, index) => ({ ...checkAmendment(check, names, parts), seq: index + 1 }));
}

/**
 * Whether a `validation` block declares a check set at all. A hint-only block declares none, and an
 * omitted array is **not** an empty one: ingesting `checks: []` supersedes every check on the goal,
 * which is the right reading of an explicit `[]` and the wrong reading of a plan that simply said
 * what it thought was worth checking. → [20](../../docs/spec/20-validation.md#amendment)
 */
export function declaresCheckSet(block: ValidationBlock): boolean {
  return block.checks !== undefined || block.resources !== undefined;
}

export function validationCheckAmendments(
  checks: readonly DeclaredCheck[],
  resourceNames: readonly string[],
  parts: readonly CoveredPart[],
): ValidationCheckAmendment[] {
  const names = new Set(resourceNames);
  return checks.map((check) => checkAmendment(check, names, parts));
}

/**
 * The areas a check inherits: the `coverage` of every test part its `covers` names, de-duplicated and
 * in the order the check named them. **This is the whole of how a check comes to have an area** — it
 * is never authored on the check itself, which is what keeps declaring coverage one deliberate act on
 * the plan, made where an operator approves it, rather than a field an agent halfway through a part
 * can set.
 *
 * More than one is not resolved here. A check is verified against **one** selector, so a check
 * inheriting two areas is refused where it is authored rather than quietly run against the first.
 */
export function coveredAreas(covers: readonly string[], parts: readonly CoveredPart[]): string[] {
  const coverage = new Map(parts.map((part) => [part.slug, part.coverage]));
  const areas: string[] = [];
  for (const slug of covers) {
    const area = coverage.get(slug) ?? null;
    if (area !== null && !areas.includes(area)) areas.push(area);
  }
  return areas;
}

/**
 * A check inheriting **two** areas, refused where it is authored. A check is verified against one
 * selector — the pre-flight matches one, the report is read under one — so there is no honest way to
 * run a check that covers two test parts covering different areas. Taking the first silently is the
 * failure this subsystem is built to avoid: the second area is never run and the check reports a pass
 * for coverage nobody exercised. The author splits the check, or drops a `covers` entry.
 */
export function twoAreaRefusal(
  checks: readonly { id: string; covers: readonly string[] }[],
  parts: readonly CoveredPart[],
): string | null {
  for (const check of checks) {
    const areas = coveredAreas(check.covers, parts);
    if (areas.length < 2) continue;
    return (
      `check "${check.id}" covers parts that declare different areas — ${areas.map((a) => `\`${a}\``).join(' and ')}. ` +
      'A check is run against one selector and its report is read under one, so a check spanning two ' +
      'areas would report a pass for coverage nothing exercised. Split it into one check per area, or ' +
      'drop the "covers" entry that is not what this check exercises.'
    );
  }
  return null;
}

function checkAmendment(
  check: DeclaredCheck,
  names: ReadonlySet<string>,
  parts: readonly CoveredPart[],
): ValidationCheckAmendment {
  const slugs = new Set(parts.map((part) => part.slug));
  const covers = check.covers.filter((slug) => slugs.has(slug));
  return {
    id: check.id,
    title: check.title,
    do: check.do,
    expect: check.expect,
    uses: check.uses.filter((name) => names.has(name)),
    covers,
    fleetCandidate: check.fleetCandidate,
    candidateWhy: check.fleetCandidate ? (check.why ?? null) : null,
    area: coveredAreas(covers, parts)[0] ?? null,
  };
}

export function validationResourceInputs(resources: readonly DeclaredResource[]): ValidationResourceInput[] {
  return resources.map((resource) => ({
    name: resource.name,
    kind: resource.kind ?? null,
    note: resource.note ?? null,
    provided: resource.provided,
  }));
}

export function nextCheckLetter(taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 0; ; n += 1) {
    const letter = letterAt(n);
    if (!used.has(letter)) return letter;
  }
}

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
