import { z } from 'zod';
import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import { assessIssueNumber } from '../delivery/assessment.js';
import { ValidationCheckSchema, ValidationResourceSchema } from './checkDocument.js';
import type { ValidationCheck, ValidationPlanRecord } from '../types.js';

// → docs/spec/20-validation.md#when-the-check-set-is-written

/**
 * The validation planner's dispatch origin. One per goal — there is one check set and it is written
 * once — so the suffix carries no id, which is `assess` and `retro`'s shape rather than
 * `validate:<check>`'s. It is declared, with its role, in `src/issueOrigins.ts`.
 */
export function validationPlanOrigin(issueNumber: number): string {
  return issueOriginRef('validationPlan', issueNumber);
}

function validationPlanIssue(originRef: string | null): number | null {
  return issueOriginNumber('validationPlan', originRef);
}

export function validationPlanBranch(issueNumber: number): string {
  return `validate-plan/issue/${issueNumber}`;
}

/**
 * Which dispatches may write a goal's check set, declared in one place so the tool's fence and the
 * rules that brief for it cannot drift. Two do: the **assessor**, which writes it in the turn it
 * answers `delivered` — one agent, two outputs, against code that by its own verdict is not moving
 * again — and the **validation planner**, which is now the catch-up for a turn that ended before it
 * got there. Widening this list is widening who may speak for the whole set.
 * → docs/spec/20-validation.md#when-the-check-set-is-written
 */
export function checkSetAuthoringIssue(originRef: string | null): number | null {
  return validationPlanIssue(originRef) ?? assessIssueNumber(originRef);
}

/**
 * A goal whose check set is authored: either the validation planner has written one, or the goal
 * carries a plan-time set somebody is **halfway through**. Neither is a goal the planner should be
 * dispatched for.
 *
 * The second arm is the narrow one, and narrowing it is the whole of why a plan-time set is not
 * simply "authored". A plan document writes its checks before the code exists, so they carry no
 * `steps` and therefore no `area` — and an area is what lets the browser half run at all
 * ([36](../../docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area)). Counted as an
 * authored set, such a goal never sees a planner, never gains a step, and every check on it falls to
 * a person for good, on a deployment configured to automate them. Nothing is red, because a bench of
 * manual rows is what a bench of manual rows looks like.
 *
 * So what is protected is the **reading**, never the row: a set carrying any operator verdict —
 * passed, failed, waived, deferred — is work in progress and is left exactly where it is, because
 * re-authoring supersedes checks and withdraws what somebody already ran. A set whose live checks are
 * every one of them `unrun` has no reading to lose, and the planner writes a better one against the
 * merged code. → docs/spec/20-validation.md#a-plan-time-check-set-that-nobody-has-run
 */
export function checkSetAuthored(input: {
  record: ValidationPlanRecord | null;
  checks: readonly ValidationCheck[];
}): boolean {
  if (input.record?.authoredAt != null) return true;
  // A record carrying the planner's own `note` with no stamp is a set an operator sent back. The rows
  // it wrote are still there — that is deliberate, so the next planner amends rather than starts over
  // — and reading them as somebody's live set here would leave the goal with no planner and a refused
  // check set nobody ever rewrites. → docs/spec/20-validation.md#when-an-operator-sends-a-check-set-back
  if (input.record?.note != null) return false;
  return input.checks.some(planTimeCheckIsUnderway);
}

/**
 * Whether one plan-time check is work somebody has started. A reading is the obvious case; a claim
 * and a hand-over are the two quiet ones — an operator who handed a check to the fleet has acted on
 * that row as deliberately as one who ran it, and re-authoring would supersede the hand-over before
 * the agent it was handed to ever reached it. A superseded row is none of these: it is already off
 * the bench, kept as the record of what a replan dropped.
 */
function planTimeCheckIsUnderway(check: ValidationCheck): boolean {
  if (check.supersededReason !== null) return false;
  return check.state !== 'unrun' || check.claimedBy !== null || check.actor !== 'human';
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
  /** The goal's criteria, one per entry, as the current version states them. */
  criteria?: readonly string[];
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
      '**It is a hint and not an order.** It is prose, it binds nothing, and it was written by an agent ' +
        'reading the repository *before* any of this existed — it could not see what shipped, what the parts ' +
        'turned into, or what the code in front of you now makes worth running. You can. So read it as the ' +
        'best guess somebody made early, and then apply your own: check what it names where the delivered ' +
        'code says that still matters, drop what the code no longer does or the suite now settles, and add ' +
        'what it could not have known to ask for. A set that is the hint transcribed into checks is a set ' +
        'authored by the agent that could see least.\n',
      'What you may not do is depart from it **silently**. Where you went a different way — a check it asked ' +
        'for that you did not write, a check you wrote that it never mentioned — **say so in your note**, and ' +
        'say why. An operator approved this goal on the strength of that intent and is entitled to see what ' +
        'became of it.\n',
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

  const criteria = input.criteria ?? [];
  if (criteria.length > 0) {
    lines.push(
      '## What the operator said "done" means\n',
      ...criteria.map((c) => `- ${c}`),
      '',
      "These are the goal's own criteria, written by the operator before any plan existed, and they are the " +
        'authority on the goal. Write **at least one check per criterion**, and name the criteria each check ' +
        'answers in its `satisfies`, copying each exactly as it is listed above. A criterion no check names is ' +
        'drawn as a gap on the sheet and on the close-out. The bar for a check still holds: where a criterion ' +
        'is settled by the diff or the suite, the check that answers it can say so in its `do`.\n',
    );
  }

  if (input.environments !== '') lines.push(input.environments);
  lines.push(TEST_PLAN_NOTE, WRITING_NOTE);
  return lines.join('\n');
}

/**
 * The assessor's second output, **appended** to the rendered `issue-assess` prompt ahead of
 * {@link authoringBriefing} rather than interpolated — an operator override that never learned a new
 * `{token}` would drop the whole fold silently, on exactly the deployments that customised most.
 * It is rendered only for a goal that has a plan and no check set, which is the pair of gates rule
 * `validation-plan` was carrying on its own.
 * → docs/spec/20-validation.md#when-the-check-set-is-written
 */
export function assessAuthoringNote(): string {
  return `\n\n---\n
## If you answer \`delivered\`, write the check set too

You are the last agent on this goal, and a \`delivered\` verdict is the moment nothing further is
coming. So the same reading that decides the verdict also settles what somebody should *run* against
the finished thing — and doing it here saves a second agent re-deriving it tomorrow from the same
checkout you are standing in.

**Cast the verdict first, with \`assess_issue\`, and call \`validation_plan\` after it.** That order is
not a style note: the verdict is what parks the goal, and a turn that ends between the two leaves the
goal parked with the check set still owed, which rule \`validation-plan\` picks up on the next pulse.
A turn that ends *before* the verdict has decided nothing, and the goal comes back round to an
assessor — so never write a check set for a goal you have not just called delivered.

**On \`more_work\`, write nothing.** The goal goes back to the fleet, more pull requests land, and the
code any check you wrote was written against moves underneath it. Say what is missing and stop.

The rest of this section is what the check set is written from.
`;
}

/**
 * How the two fields that stay the planner's own words are written. Appended rather than
 * interpolated, for the reason everything an agent must read is.
 *
 * The operator meets `note` and `expect` on a card, at the moment they are deciding whether to
 * release the set — not in a document they sit down with. Written as one dense paragraph both are
 * read by skimming, which is how an operator accepts a set whose second half they never took in.
 * → docs/spec/20-validation.md#how-the-note-and-the-expect-are-written
 */
const WRITING_NOTE = `## Write the note and every \`expect\` as grouped bullets

They are the two things on the approval card that stay your own words, and an operator meets them
while deciding whether to release the set. Both are markdown, and the card draws them as markdown.

- **Bullets, not paragraphs.** One fact per bullet. A bullet that needs a semicolon is two bullets.
- **Group them under short bold headings** where there is more than a handful — \`**The numbers**\`,
  \`**The logs**\`, \`**On screen**\`. Three or four bullets need no headings at all.
- **Plain language, short sentences.** Write what somebody has to see, not an argument for it.
- **Put the numbers and the log lines in the bullets** — \`41 of 74 rows\`, the line as a
  \`code span\`. They are what the check is actually falsifiable on.
- **Anything an operator has to weigh before accepting goes last, under its own heading** — a
  check that needs live data, a customer named on purpose, something you deliberately did not do.
  One or two bullets, said plainly.

For \`note\`, the first group is where the set came from: the hint, or the delivered code you read in
its place. What you deliberately left out of the set is its own group, with what already settles it.

This is about form only. It removes nothing you would have said and adds nothing you would not.
`;

/**
 * The test plan, appended rather than interpolated for the reason everything an agent must read is:
 * `loadPromptTemplates` rejects only *unknown* placeholders, so an override that never learned this
 * would drop it silently, on exactly the deployments that customised most.
 * → docs/spec/20-validation.md#the-test-plan
 */
const TEST_PLAN_NOTE = `## Give a check a test plan

A check may carry \`steps\`. A step says **which instrument the check needs and what to find out with
it** — never a route. Where an agent carries a step, it works out the clicks itself against the
application that is actually up; a step that scripts them is a guess about a screen you are reading
the source of rather than looking at, and the agent is the one looking.

| kind | what it needs, and what you write in its \`do\` |
| --- | --- |
| \`browser\` | The application, driven. Where to go and what to find out there. |
| \`suite\` | A **named area** of the project's own permanent browser suite. See below — this one is the exception, and it is rarely the right move. |
| \`screenshot\` | A screen captured for somebody to look at. What has to be on it. |
| \`state\` | The deployed store, read. What should be in it. |
| \`signal\` | The logs and error records. What should be in them, and what should not. |
| \`measure\` | A metric. What it should read. |
| \`manual\` | Something only a person can do. |

The ordering is the point, and it is the one thing prose in a \`do\` cannot say to anything but a
reader: a store or log reading whose subject is *what the browser steps just did* is meaningless
taken before them.

**Write \`browser\`, not \`suite\`, unless the journey is permanent.** A \`suite\` step names an area
of the repository's own test suite, as the runner selects on it, and that string is matched
**exactly** against the deployed commit's own listing when the run happens — a name that does not
resolve **blocks the row** rather than running anything. So it is worth that risk only where the
journey is one the product will keep having and the suite genuinely already covers it, and only
where you ran the listing command above and read the name off it. If you did not run the listing, or
it would not run, or you are naming coverage this goal has only just added: write a plain
\`browser\` step. An agent driving the application answers *does this goal work* directly, which is
the question a check exists to ask, and it can never be blocked by a string.

**A \`suite\` step also takes \`expects\`: the concrete spec names you expect that area to run**, named
the same way the area is. Where you write a \`suite\` step at all, write these too — they are the only
thing that can catch a spec **deleted or renamed** since you wrote the check: the area goes on running
whatever it now holds, and the count of what it holds moves down with the deletion, so a name nobody
wrote down simply goes missing and the row reports a pass for coverage that no longer exists.

## Say what would prove it

A check an agent carries out unwatched goes green **on that agent's word**. Nothing reviewed it and
nobody watched it, and the sheet says so — such a reading is recorded as \`agent\`, which is the
weakest evidence on it.

\`proof\` is what you do about that. It is what has to come **back** for a pass to count: name the
screen, and what has to be visible on it. A check that declares it is **refused a pass that hands
nothing back** — the run records \`blocked\` instead, and an agent reporting through a tool is told
to report what it actually saw. So it costs an operator nothing and it is the difference between a
green row somebody can check and a green row they have to trust.

Write it on every check whose steps the fleet can carry. Leave it out where the assertion is the
whole of the evidence and there is nothing to photograph — a store reading, a log line, a \`suite\`
area's own machine-readable report.

It is not a second \`expect\`. \`expect\` is what has to be **true**; \`proof\` is what has to be
**handed back** to show it. *The batch page shows 412 rows* is an \`expect\`; *a screen of the batch
page with the row count visible* is the \`proof\`.

**"Somebody needs to look at this" is a \`screenshot\` step, not a \`manual\` one.** Where the deployment
drives a browser, the fleet goes to the screen and captures it, and a person judges the image at their
leisure — so the going and the looking cost nobody a trip, and what is left on the bench is the
judgement, which is the part that actually needed a person. Reach for \`manual\` for what no agent can
reach at all: a console nobody gave the fleet an account for, something physically plugged in, a
decision that is somebody else's to make. A screen described as \`manual\` on a deployment that could
have captured it is a bench row that did not have to exist, and the row above it is where the operator
stops reading.

A \`screenshot\` step and a \`proof\` are not the same thing and do not do the same job. A
\`screenshot\` step **asserts nothing**: the row reaches *captured, waiting to be looked at*, and a
person decides what it means. A \`proof\` rides a check that **did** assert — the agent says it
passed and hands over the evidence, and nobody is put back in front of it. Reach for the first where
the judgement is genuinely somebody's; reach for the second everywhere else.

**Who carries each step is not yours to say.** It is read off what the deployment declares above: a
step whose kind nothing here can drive comes back to a person, with the configuration that would have
carried it named on the row. That is a fact rather than a nomination, which is why you write what the
check needs and not who does it.

**A \`manual\` step's \`when\` is yours, and it matters more than it looks.** \`deferred\` is *somebody
looks at this afterwards*: the run completes and it costs the sequence nothing. \`inline\` stops the
run where it sits, because no agent holds a session across a person's day — so an inline step splits
the check into two runs with a wait between them, and a check whose **first** step is an inline
person's can never be dispatched at all. Write \`deferred\` wherever you mean it.

Steps are optional. A check that is a person's journey end to end is well described by its \`do\`, and
that is what most checks have always been.
`;

/**
 * What the deployment can drive, fleet-wide rather than per goal, so it is folded once and handed to
 * the rule. It names no areas: nothing pre-resolves one at plan time any more, and a `suite` step's
 * area is resolved against the deployed commit's own listing when the run happens.
 *
 * What it does carry is the **`listSelectors` command itself**, for the planner to invoke in the
 * checkout it is standing in. A listing and a cached area are different things: a stored string that
 * resolves later can be stale invisibly, which is why the cache went; a command the planner runs now,
 * with run-time resolution untouched, is vocabulary rather than an answer — the pre-flight still has
 * the last word, so a listing taken here cannot produce a false pass. Without it the planner names an
 * area with no vocabulary at all, and a repository that names things twice — a runner selecting on
 * tags while its config file carries human-readable project names — gives it two honest readings and
 * no way to tell which the runner will accept.
 * → docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area
 *
 * Empty where nothing declares a `validate` block — a deployment with no configured environment
 * still authors a check set, and every check on it is a person's.
 */
export function validationPlanNote(
  environments: readonly {
    name: string;
    watch?: { observe: string };
    validate?: {
      permits: readonly string[];
      tenant?: string;
      tenantEnv?: string;
      ensureTenant?: string;
      browser?: { runner: string; listSelectors?: string };
      state?: { run: string };
    };
  }[],
): string {
  const configured = environments.filter((env) => env.validate !== undefined);
  if (configured.length === 0) return '';
  const lines = ['## Where this goal can be checked\n'];
  for (const env of configured) {
    const validate = env.validate;
    if (validate === undefined) continue;
    const can: string[] = [];
    // Named by step kind, because that is the join the planner has to make: a step whose kind
    // nothing here carries comes back to a person. → docs/spec/20-validation.md#who-carries-a-step
    if (validate.browser !== undefined)
      can.push('drives a browser through the project’s own suite (`browser`, `suite`, `screenshot` steps)');
    if (validate.state !== undefined) can.push('reads the deployed store (`state` steps)');
    if ((env.watch?.observe ?? '').trim() !== '')
      can.push('reads logs, error records and metrics (`signal` and `measure` steps)');
    lines.push(
      `- **${env.name}** — permits ${validate.permits.map((kind) => `\`${kind}\``).join(', ')}` +
        (can.length === 0 ? '.' : `; ${can.join(', and ')}.`) +
        (validate.tenant === undefined && validate.tenantEnv === undefined && validate.ensureTenant === undefined
          ? ' No tenant is configured, so a run that writes has nowhere to write and a `browser` step is a person’s.'
          : ''),
    );
  }
  lines.push('', ...areaVocabulary(configured));
  lines.push(
    'Where nothing above can carry a check, the check is a person’s, which is the ordinary case and not a ' +
      'lesser answer.\n',
  );
  return lines.join('\n');
}

/**
 * The vocabulary a `suite` area is written in, and the command that prints it where one is declared.
 *
 * It is **advisory on every arm**, which is what keeps restoring it from restoring the cache that
 * went with it. The planner stands in a checkout of the default branch rather than the deployed
 * commit, so what the command prints here describes a neighbouring build — good enough to tell a tag
 * from a config file's project name, and never an answer. Nothing is stored, nothing is resolved, and
 * the run's own listing against the deployed commit decides. A command that will not run is therefore
 * not a blocked plan: it degrades to prose, which is what every check written before this was.
 * → docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area
 */
function areaVocabulary(
  configured: readonly { name: string; validate?: { browser?: { listSelectors?: string } } }[],
): string[] {
  const listings = configured
    .map((env) => ({ name: env.name, command: env.validate?.browser?.listSelectors }))
    .filter((entry): entry is { name: string; command: string } => (entry.command ?? '').trim() !== '');
  const lines = [
    'A `suite` area is named **as the runner selects on it** — the identifier its own listing prints. That ' +
      'is often not what a test-framework config file calls the project, the group or the suite, and it is ' +
      'never a spec file path or a directory: a repository that names the same journey twice gives you two ' +
      'honest readings, and only the one the runner selects on can ever match. The same goes for a step’s ' +
      '`expects`, one level down.\n',
  ];
  if (listings.length === 0) {
    lines.push(
      'No environment here declares a command that prints that listing, so write the area as the suite names ' +
        'it in the repository you are standing in and say in the check’s `do` which suite you read it off.\n',
    );
  } else {
    lines.push(
      'Before you write one, ask the runner what it offers, in the checkout you are standing in:\n',
      ...listings.map((entry) => `- **${entry.name}** — \`${entry.command}\``),
      '',
      'What it prints is **the vocabulary and not the answer**. You are standing in the default branch and ' +
        'not in the commit an environment is running, so read it for the *shape* of the names — and where a ' +
        'goal added an area that has not deployed yet, write the name the new spec will be selected by rather ' +
        'than the nearest one on this list.\n',
      '**If it will not run, write the area anyway and carry on.** No install, no credentials, too slow, an ' +
        'error you cannot read — none of those is a reason to leave a `suite` step out, defer a check or say ' +
        'anything in the note about it. Name the area as the suite names it in the repository, exactly as ' +
        'every check written before this list existed was named.\n',
    );
  }
  lines.push(
    'Whatever you write is resolved against the deployed commit’s own listing when the run happens, and a ' +
      'name that does not resolve blocks the row with both lists side by side. That is the check on this, ' +
      'and it does not move.\n',
  );
  return lines;
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
