import { z } from 'zod';
import type { ValidationCheckAmendment, ValidationCheckInput, ValidationResourceInput } from '../types.js';
import { NO_STEP_CAPABILITIES, resolveSteps, STEP_KINDS, stepArea, type StepCapabilities } from './steps.js';
import type { ValidationStepKind } from '../types.js';

// → docs/spec/20-validation.md

const MAX_CHECKS = 40;

const MAX_RESOURCES = 20;

const MAX_STEPS = 20;

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

/**
 * One step of a check's test plan. The author declares **what** and, for a person's step, **when**;
 * `actor` is not among them, exactly as it is not on the check — who carries a step is read off the
 * configuration at ingestion. → docs/spec/20-validation.md#who-carries-a-step
 */
const ValidationStepSchema = z
  .object({
    kind: z.enum(STEP_KINDS as unknown as [ValidationStepKind, ...ValidationStepKind[]]),
    do: z.string().min(1),
    area: z.string().min(1).optional(),
    when: z.enum(['inline', 'deferred']).optional(),
  })
  .strict('a step declares only kind/do/area/when — who carries it is read off the configuration, not yours to say')
  .superRefine((step, ctx) => {
    const add = (message: string, path: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    // An area on any other kind would be a second author for the string a `suite` step names, and
    // the pre-flight compares that string character for character.
    if (step.area !== undefined && step.kind !== 'suite')
      add(`"area" belongs to a "suite" step — a ${step.kind} step runs no named area of the suite`, 'area');
    if (step.kind === 'suite' && step.area === undefined)
      add('a "suite" step names the area it runs, copied exactly from what the runner offers', 'area');
    // Inline and deferred are the same word on any other kind: a step that runs, runs where it sits.
    if (step.when !== undefined && step.kind !== 'manual')
      add(`"when" belongs to a "manual" step — a ${step.kind} step is taken where it sits`, 'when');
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
    steps: z
      .array(ValidationStepSchema)
      .optional()
      .transform((list) => (list !== undefined && list.length > MAX_STEPS ? list.slice(0, MAX_STEPS) : list)),
  })
  .strict(
    'a check declares only id/title/do/expect/uses/covers/steps/fleetCandidate/why — who runs it is not yours to say',
  );

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

/**
 * A plan document's own check set — the **legacy** shape, and the reason it survives. The check set
 * is authored after delivery now ([20](../../docs/spec/20-validation.md#when-the-check-set-is-written)),
 * but a plan carrying `checks` was ingested into rows an operator may be halfway through, and
 * re-reading such a document as a hint would delete them.
 *
 * It is handed `NO_STEP_CAPABILITIES` and nothing else: a plan document is written before the code
 * exists and declares no test plan, and a legacy one that somehow carries steps gets every one of
 * them assigned to a person, which is the direction this fails in everywhere.
 */
export function validationCheckInputs(block: ValidationBlock, slugs: readonly string[]): ValidationCheckInput[] {
  const names = new Set((block.resources ?? []).map((r) => r.name));
  return (block.checks ?? []).map((check, index) => ({
    ...checkAmendment(check, names, new Set(slugs), NO_STEP_CAPABILITIES),
    seq: index + 1,
  }));
}

/**
 * Whether a `validation` block declares a check set at all. A hint-only block declares none, and an
 * omitted array is **not** an empty one: ingesting `checks: []` supersedes every check on the goal,
 * which is the right reading of an explicit `[]` and the wrong reading of a plan that simply said
 * what it thought was worth checking. → [20](../../docs/spec/20-validation.md#amendment)
 */
/**
 * The validation planner's own check set, on the same shapes and with the deployment's capabilities
 * read in — which is the difference from the legacy plan-document path above and the whole of why
 * a step can be the fleet's here and never there.
 */
export function validationCheckSetInputs(
  checks: readonly DeclaredCheck[],
  resources: readonly DeclaredResource[],
  slugs: readonly string[],
  caps: StepCapabilities,
): ValidationCheckInput[] {
  const names = new Set(resources.map((r) => r.name));
  const live = new Set(slugs);
  return checks.map((check, index) => ({ ...checkAmendment(check, names, live, caps), seq: index + 1 }));
}

export function declaresCheckSet(block: ValidationBlock): boolean {
  return block.checks !== undefined || block.resources !== undefined;
}

export function validationCheckAmendments(
  checks: readonly DeclaredCheck[],
  resourceNames: readonly string[],
  slugs: readonly string[],
  caps: StepCapabilities,
): ValidationCheckAmendment[] {
  const names = new Set(resourceNames);
  const live = new Set(slugs);
  return checks.map((check) => checkAmendment(check, names, live, caps));
}

function checkAmendment(
  check: DeclaredCheck,
  names: ReadonlySet<string>,
  slugs: ReadonlySet<string>,
  caps: StepCapabilities,
): ValidationCheckAmendment {
  const steps = resolveSteps(check.steps ?? [], caps);
  return {
    id: check.id,
    title: check.title,
    do: check.do,
    expect: check.expect,
    uses: check.uses.filter((name) => names.has(name)),
    covers: check.covers.filter((slug) => slugs.has(slug)),
    fleetCandidate: check.fleetCandidate,
    candidateWhy: check.fleetCandidate ? (check.why ?? null) : null,
    // A `suite` step names it, and nothing else does. It was inherited from the `coverage` of a test
    // part the check happened to `covers`, which made a check automatable by accident.
    // → docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area
    area: stepArea(steps),
    steps,
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
