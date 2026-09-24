import { z } from 'zod';
import type { ValidationCheckAmendment, ValidationCheckInput, ValidationResourceInput } from '../types.js';
import { NO_STEP_CAPABILITIES, resolveSteps, STEP_KINDS, type StepCapabilities } from './steps.js';
import type { ValidationStepKind } from '../types.js';

// → docs/spec/20-validation.md

const MAX_CHECKS = 40;

const MAX_RESOURCES = 20;

const MAX_STEPS = 20;

/**
 * A one-off script is small and goal-scoped — that is what makes reading it cheaper than trusting
 * it, which is the whole argument for drawing it beside its reading. Past this it is not a one-off,
 * it is a suite nobody reviewed.
 */
const MAX_SCRIPT_LENGTH = 8000;

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
    expects: z.array(z.string().min(1)).optional(),
    when: z.enum(['inline', 'deferred']).optional(),
    script: z.string().min(1).max(MAX_SCRIPT_LENGTH).optional(),
  })
  .strict(
    'a step declares only kind/do/area/expects/when/script — who carries it is read off the configuration, ' +
      'not yours to say',
  )
  .superRefine((step, ctx) => {
    const add = (message: string, path: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    // An area on any other kind would be a second author for the string a `suite` step names, and
    // the pre-flight compares that string character for character.
    if (step.area !== undefined && step.kind !== 'suite')
      add(`"area" belongs to a "suite" step — a ${step.kind} step runs no named area of the suite`, 'area');
    if (step.kind === 'suite' && step.area === undefined)
      add('a "suite" step names the area it runs, as the runner selects on it — not as a config file names it', 'area');
    // The same string the pre-flight compares character for character, one level down; and the same
    // rule about a second author, for the same reason.
    if (step.expects !== undefined && step.kind !== 'suite')
      add(`"expects" belongs to a "suite" step — a ${step.kind} step runs no named spec of the suite`, 'expects');
    // Inline and deferred are the same word on any other kind: a step that runs, runs where it sits.
    if (step.when !== undefined && step.kind !== 'manual')
      add(`"when" belongs to a "manual" step — a ${step.kind} step is taken where it sits`, 'when');
    // A one-off script acts on the environment, and `browser` is the only kind that does. On a
    // `suite` step it would be a second, unreviewed body of code wearing a reviewed step's clothes;
    // on a `screenshot` step it would be an assertion on the one kind that must never assert.
    if (step.script !== undefined && step.kind !== 'browser')
      add(
        `"script" belongs to a "browser" step — a ${step.kind} step runs nothing of its own, and a one-off ` +
          'script is the browser-shaped instrument',
        'script',
      );
  });

/**
 * The same test plan as the agent is shown it: the tool-facing shape both transports that author a
 * check set advertise. `validation_plan` and `validation_amend` differ deliberately in the prose on
 * every other field — one speaks for a whole set, the other for the checks it names — but a step
 * kind means the same thing in both, so the vocabulary and its gloss are declared once here and the
 * enum is read off `STEP_KINDS` rather than restated.
 * → docs/spec/11-mcp-tools.md, docs/spec/20-validation.md#the-test-plan
 */
export const validationStepsSchema = z
  .array(
    z.object({
      kind: z
        .enum(STEP_KINDS as unknown as [ValidationStepKind, ...ValidationStepKind[]])
        .describe(
          '"browser" drives the application; "suite" runs a named area of the project’s own browser ' +
            'suite; "screenshot" captures the screen; "state" reads the deployed store; "signal" reads ' +
            'logs and error records; "measure" reads a metric; "manual" is something only a person can do.',
        ),
      do: z.string().describe('What this step does, concretely.'),
      area: z
        .string()
        .describe(
          'A "suite" step only, and required on one: the area to run, named exactly as the **runner ' +
            'selects on it** — the identifier its own listing prints, which is often not what a ' +
            'test-framework config file calls the project or group, and never a spec file path. It is ' +
            'resolved against the deployed commit’s own ' +
            'listing when the run happens, and a name that does not resolve blocks the row with both ' +
            'lists side by side. It is also what gives the check its area.',
        )
        .optional(),
      expects: z
        .array(z.string())
        .describe(
          'A "suite" step only, and optional on one: the **concrete spec names** you expect that area to ' +
            'run, named as the runner selects on them, exactly as the area is. Writing them down ' +
            'is the only thing that can catch a ' +
            'spec that has been **deleted or renamed** since — the area still runs whatever it now holds, ' +
            'and the count moves with it, so a name you did not write down goes missing in silence. They ' +
            'are resolved against the deployed commit’s own listing when the run happens, and a name it ' +
            'does not offer blocks the row instead of passing on what remains.',
        )
        .optional(),
      when: z
        .enum(['inline', 'deferred'])
        .describe(
          'A "manual" step only. "deferred" is *somebody looks at this afterwards* and costs the run ' +
            'nothing. "inline" stops the run where it sits — no agent holds a session across a ' +
            'person’s day — so an inline step in an otherwise automated plan splits the check into two ' +
            'runs with a wait between them. Default is "inline"; say "deferred" when you mean it.',
        )
        .optional(),
      script: z
        .string()
        .describe(
          'A "browser" step only: a **one-off script** — the source of a small program that drives ' +
            'this one journey and asserts on it. It is run as it stands, inside the run’s tenant, and ' +
            'it is never committed, never reviewed and never in a pull request: it exists to answer ' +
            'this check and is deleted with the goal. So write it self-contained, keep it short enough ' +
            'that a person reads it in a minute — its source is drawn on the sheet beside its reading, ' +
            'because reading it is cheaper than trusting it — and have it emit the harness’s report ' +
            'shape with `selector` set to this check’s own id. A reading it produces is attributed ' +
            '"script" and never "spec": nothing reviewed it. Omit it for a browser step a person drives.',
        )
        .optional(),
    }),
  )
  .describe(
    'The test plan: one ordered journey through the delivered goal, in order. The ordering is the ' +
      'point — a store or log reading whose subject is what the browser steps just did is meaningless ' +
      'taken before them. Who carries each step is **not yours to say**: it is read off what the ' +
      'deployment declares it can drive. Omit it to leave the check as prose.',
  )
  .optional();

export const ValidationCheckSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: z.string().min(1),
    do: z.string().min(1),
    expect: z
      .string()
      .min(1)
      .describe(
        'What a pass looks like — everything this one run has to satisfy. Markdown, and the ' +
          'approval card draws it as markdown: write it as **grouped bullets**, one fact per ' +
          'bullet, under short bold headings where there is more than a handful. Put the numbers ' +
          'and the log lines in the bullets — they are what the check is falsifiable on. An ' +
          'operator reads this while deciding whether to release the set, so a dense paragraph is ' +
          'read by skimming.',
      ),
    proof: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'What must come **back** for a pass to count — the evidence, not the assertion. A screen of ' +
          'the page that proves it, named for what has to be visible on it. Write it wherever the ' +
          'check is one an agent carries out unwatched: it is the only thing standing between an ' +
          'agent\u2019s word and a green row, and a check that declares it cannot be recorded as ' +
          'passed without it. Leave it out where the assertion is the whole of the evidence \u2014 a ' +
          'store reading, a log line, a suite area\u2019s own report.',
      ),
    uses: z.array(z.string().min(1)).default([]),
    covers: z.array(z.string().min(1)).default([]),
    satisfies: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'The goal criteria this check answers, each copied exactly as the criteria list states it. Every ' +
          'criterion needs at least one check naming it; one that names nothing is drawn as a gap.',
      ),
    fleetCandidate: z.boolean().default(false),
    why: z.string().min(1).optional(),
    steps: z
      .array(ValidationStepSchema)
      .optional()
      .transform((list) => (list !== undefined && list.length > MAX_STEPS ? list.slice(0, MAX_STEPS) : list)),
  })
  .strict(
    'a check declares only id/title/do/expect/proof/uses/covers/satisfies/steps/fleetCandidate/why — who runs it is not yours to say',
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
export function validationCheckInputs(
  block: ValidationBlock,
  slugs: readonly string[],
  criteria: readonly string[] = [],
): ValidationCheckInput[] {
  const names = new Set((block.resources ?? []).map((r) => r.name));
  return (block.checks ?? []).map((check, index) => ({
    ...checkAmendment(check, names, new Set(slugs), new Set(criteria), NO_STEP_CAPABILITIES),
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
  criteria: readonly string[] = [],
): ValidationCheckInput[] {
  const names = new Set(resources.map((r) => r.name));
  const live = new Set(slugs);
  const stated = new Set(criteria);
  return checks.map((check, index) => ({ ...checkAmendment(check, names, live, stated, caps), seq: index + 1 }));
}

export function declaresCheckSet(block: ValidationBlock): boolean {
  return block.checks !== undefined || block.resources !== undefined;
}

export function validationCheckAmendments(
  checks: readonly DeclaredCheck[],
  resourceNames: readonly string[],
  slugs: readonly string[],
  caps: StepCapabilities,
  criteria: readonly string[] = [],
): ValidationCheckAmendment[] {
  const names = new Set(resourceNames);
  const live = new Set(slugs);
  const stated = new Set(criteria);
  return checks.map((check) => checkAmendment(check, names, live, stated, caps));
}

function checkAmendment(
  check: DeclaredCheck,
  names: ReadonlySet<string>,
  slugs: ReadonlySet<string>,
  criteria: ReadonlySet<string>,
  caps: StepCapabilities,
): ValidationCheckAmendment {
  const steps = resolveSteps(check.steps ?? [], caps);
  return {
    id: check.id,
    title: check.title,
    do: check.do,
    expect: check.expect,
    proof: check.proof ?? null,
    uses: check.uses.filter((name) => names.has(name)),
    covers: check.covers.filter((slug) => slugs.has(slug)),
    satisfies:
      check.satisfies === undefined ? undefined : check.satisfies.map((c) => c.trim()).filter((c) => criteria.has(c)),
    fleetCandidate: check.fleetCandidate,
    candidateWhy: check.fleetCandidate ? (check.why ?? null) : null,
    // The steps are the whole of it. The area a check is verified against and the spec names it
    // expects are read off its own `suite` step wherever they are wanted — `stepArea` and
    // `stepExpects` — and are copied nowhere, so there is no second home to fall out of date.
    // → docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area
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
