import { z } from 'zod';
import { ValidationCheckSchema, ValidationResourceSchema } from './checkDocument.js';
import type { SelectorOffering, ValidationCheck, ValidationPlanRecord } from '../types.js';

// → docs/spec/20-validation.md#when-the-check-set-is-written

/**
 * The validation planner's dispatch origin. One per goal — there is one check set and it is written
 * once — so the suffix carries no id, which is `assess` and `retro`'s shape rather than
 * `validate:<check>`'s. It is classified in `src/issueOrigins.ts`; left out it reads as
 * `unrecognised` and its spend files under "other".
 */
export function validationPlanOrigin(issueNumber: number): string {
  return `issue:${issueNumber}:validate-plan`;
}

export function validationPlanIssue(originRef: string | null): number | null {
  const match = /^issue:(\d+):validate-plan$/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

export function validationPlanBranch(issueNumber: number): string {
  return `validate-plan/issue/${issueNumber}`;
}

/**
 * A goal whose check set is authored: either the validation planner has written one, or the goal
 * carries checks a plan document ingested before authoring moved. Both are a set somebody may be
 * halfway through, and neither is a goal the planner should be dispatched for.
 */
export function checkSetAuthored(input: {
  record: ValidationPlanRecord | null;
  checks: readonly ValidationCheck[];
}): boolean {
  return input.record?.authoredAt != null || input.checks.length > 0;
}

/**
 * The parts a briefing reads. It picks the ones declaring `coverage` out itself rather than being
 * handed them, which keeps that read out of `src/dispatcher/` — `coverage` decides what a permanent
 * suite covers and never what the harness does with a part.
 */
interface BriefedPart {
  slug: string;
  title: string;
  coverage?: string | null;
  acceptance: string | null;
}

/**
 * Everything the validation planner must read, **appended** to the rendered prompt rather than
 * interpolated: the plan's hint, what any `coverage` part built, and what the deployment can
 * actually drive. An operator override that never learned a new `{token}` drops an interpolated one
 * silently, on exactly the deployments that customised most.
 */
export function authoringBriefing(input: {
  hint: string | null;
  parts: readonly BriefedPart[];
  environments: string;
}): string {
  const covering = input.parts.filter((part) => part.coverage !== null && part.coverage !== undefined);
  const lines = ['\n\n---\n', '## What the plan said was worth checking\n'];
  if (input.hint === null) {
    lines.push(
      'The plan declared no hint. That is an ordinary answer and not a gap to fill in from the ticket — ' +
        'read the delivered code and say what running it would settle.\n',
    );
  } else {
    lines.push(
      `> ${input.hint.replace(/\n/g, '\n> ')}\n`,
      'It is prose, it binds nothing, and it was written against code that did not exist yet. Where you go ' +
        'a different way, **say so in your note** — an operator approved this goal on the strength of that ' +
        'intent and is entitled to see what became of it.\n',
    );
  }

  lines.push('## Permanent coverage this goal built\n');
  if (covering.length === 0) {
    lines.push('None — no part of this plan declared `coverage`.\n');
  } else {
    lines.push(
      ...covering.map(
        (part) =>
          `- **${part.title}** (\`${part.slug}\`) — area \`${part.coverage ?? ''}\`` +
          (part.acceptance === null ? '' : `: ${part.acceptance}`),
      ),
      '',
      'That suite runs in the deployment pipeline on every change, and it **informs you rather than binding ' +
        'you**. It may settle the question, in which case declare nothing and say so; it may be worth running ' +
        'once here; or it may be worth running and then looking at more besides. What it must never be is a ' +
        'check nobody chose.\n',
    );
  }

  if (input.environments !== '') lines.push(input.environments);
  return lines.join('\n');
}

/**
 * What the deployment can drive, and the areas its runner last said it offers — fleet-wide rather
 * than per goal, so it is folded once and handed to the rule, `testPartNote`'s own arrangement.
 * The listing is the same one a planner picks `coverage` from: the two ends of `area` have to agree
 * on the string, and the pre-flight compares it character for character.
 *
 * Empty where nothing declares a `validate` block — a deployment with no configured environment
 * still authors a check set, and every check on it is a person's.
 */
export function validationPlanNote(
  environments: readonly {
    name: string;
    validate?: {
      permits: readonly string[];
      tenant?: string;
      tenantEnv?: string;
      browser?: { runner: string };
      state?: { run: string };
    };
  }[],
  offerings: readonly SelectorOffering[] = [],
): string {
  const configured = environments.filter((env) => env.validate !== undefined);
  if (configured.length === 0) return '';
  const lines = ['## Where this goal can be checked\n'];
  for (const env of configured) {
    const validate = env.validate;
    if (validate === undefined) continue;
    const can: string[] = [];
    if (validate.browser !== undefined) can.push('drives a browser through the project’s own suite');
    if (validate.state !== undefined) can.push('reads the deployed store');
    const areas = [...new Set(offerings.filter((o) => o.environment === env.name).map((o) => o.selector))].sort();
    lines.push(
      `- **${env.name}** — permits ${validate.permits.map((kind) => `\`${kind}\``).join(', ')}` +
        (can.length === 0 ? '.' : `; ${can.join(', and ')}.`) +
        (validate.tenant === undefined && validate.tenantEnv === undefined
          ? ' No tenant is configured, so a run that writes has nowhere to write.'
          : '') +
        (areas.length === 0
          ? ''
          : ` Its suite last offered: ${areas.map((area) => `\`${area}\``).join(', ')} — copied exactly, or not at all.`),
    );
  }
  lines.push(
    '',
    'A check whose area names something the suite does not offer can never be run: the string is compared ' +
      'character for character. Where nothing above can carry a check, the check is a person’s, which is the ' +
      'ordinary case and not a lesser answer.\n',
  );
  return lines.join('\n');
}

const MAX_CHECKS = 40;

const MAX_RESOURCES = 20;

/**
 * The validation planner's transport, on **the plan document's own schemas** — the same reason
 * `validation_amend` reaches for them: a second copy of those shapes drifts the first time either
 * learns a field, and the two transports must accept and reject the same checks.
 *
 * Two refusals are this one's own, and both are the same rule. A set that declares nothing must say
 * why, because null with no account of itself is indistinguishable from a planner that did nothing;
 * and every set carries a note, because a hint nobody says they departed from is theatre and the
 * operator's read at the approval gate was worth nothing.
 */
const CheckSetSchema = z
  .object({
    note: z
      .string({
        required_error: 'note is required — say where you went a different way from the plan’s hint, and why',
        invalid_type_error: 'note is required — say where you went a different way from the plan’s hint, and why',
      })
      .trim()
      .min(1, 'note is required — say where you went a different way from the plan’s hint, and why'),
    emptyReason: z.string().trim().min(1).optional(),
    checks: z
      .array(ValidationCheckSchema)
      .default([])
      .transform((list) => (list.length > MAX_CHECKS ? list.slice(0, MAX_CHECKS) : list)),
    resources: z
      .array(ValidationResourceSchema)
      .default([])
      .transform((list) => (list.length > MAX_RESOURCES ? list.slice(0, MAX_RESOURCES) : list)),
  })
  .strict('a check set declares only "note", "emptyReason", "checks" and "resources"')
  .superRefine((set, ctx) => {
    const add = (message: string, path: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    const ids = new Set<string>();
    for (const check of set.checks) {
      if (ids.has(check.id)) add(`duplicate check id "${check.id}"`, 'checks');
      ids.add(check.id);
    }
    const names = new Set<string>();
    for (const resource of set.resources) {
      if (names.has(resource.name)) add(`duplicate resource "${resource.name}"`, 'resources');
      names.add(resource.name);
    }
    if (set.checks.length === 0 && set.emptyReason === undefined) {
      add(
        'declaring no checks is a complete answer and it carries a reason — say what already settles the ' +
          'question, so an operator meeting an empty bench can tell it from a planner that never ran',
        'emptyReason',
      );
    }
  });

type ParsedCheckSet = z.infer<typeof CheckSetSchema>;

export function validateCheckSet(
  args: Record<string, unknown>,
): { ok: true; set: ParsedCheckSet } | { ok: false; error: string } {
  const parsed = CheckSetSchema.safeParse(args);
  if (parsed.success) return { ok: true, set: parsed.data };
  const first = parsed.error.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return { ok: false, error: `${where}${first?.message ?? 'invalid check set'}` };
}

export const AUTHORED_SUPERSEDED_REASON =
  'The validation planner did not include this check in the set it wrote against the delivered goal.';

export const AUTHORED_AMEND_NOTE =
  'The validation planner rewrote this check against the delivered goal. Re-read it before you rely on the ' +
  'result you had.';
