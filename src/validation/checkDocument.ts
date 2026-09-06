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
    resources: z
      .array(ValidationResourceSchema)
      .default([])
      .transform((list) => (list.length > MAX_RESOURCES ? list.slice(0, MAX_RESOURCES) : list)),
    checks: z
      .array(ValidationCheckSchema)
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

type DeclaredCheck = z.infer<typeof ValidationCheckSchema>;

type DeclaredResource = z.infer<typeof ValidationResourceSchema>;

export function validationCheckInputs(block: ValidationBlock, partSlugs: readonly string[]): ValidationCheckInput[] {
  const names = new Set(block.resources.map((r) => r.name));
  const slugs = new Set(partSlugs);
  return block.checks.map((check, index) => ({ ...checkAmendment(check, names, slugs), seq: index + 1 }));
}

export function validationCheckAmendments(
  checks: readonly DeclaredCheck[],
  resourceNames: readonly string[],
  partSlugs: readonly string[],
): ValidationCheckAmendment[] {
  const names = new Set(resourceNames);
  const slugs = new Set(partSlugs);
  return checks.map((check) => checkAmendment(check, names, slugs));
}

function checkAmendment(
  check: DeclaredCheck,
  names: ReadonlySet<string>,
  slugs: ReadonlySet<string>,
): ValidationCheckAmendment {
  return {
    id: check.id,
    title: check.title,
    do: check.do,
    expect: check.expect,
    uses: check.uses.filter((name) => names.has(name)),
    covers: check.covers.filter((slug) => slugs.has(slug)),
    fleetCandidate: check.fleetCandidate,
    candidateWhy: check.fleetCandidate ? (check.why ?? null) : null,
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
