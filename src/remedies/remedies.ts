/**
 * The remedy record: why the fleet had to come back to a pull request, and what
 * settled it.
 *
 * ## The gap this closes
 *
 * The Yield panel (`src/reliabilityInsights.ts`) already answers *how often* a
 * pull request goes red and *what answering it costs* — reds, red rate,
 * time-to-green, the `ci` phase's dollars fleet-wide and per pull request. It
 * stops exactly one question short of the one an operator asks when most of the
 * fleet is doing this work: **why**. A flaky runner, a stale assertion, a missing
 * `.js` extension and a genuine defect are the same red, the same dollars and the
 * same row on every surface the harness draws. The same is true of review
 * feedback, which has no reading at all: the agent addresses the threads and the
 * reason the reviewer objected evaporates with the run.
 *
 * ## Why the agent reports it, rather than something deriving it
 *
 * The knowledge exists, in full, for about a minute: the agent that just fixed it
 * read the failing assertion (`src/ci/ciEvidence.ts` put it in the prompt) and
 * then made the fix. Nothing else will ever know both halves as cheaply. A
 * post-hoc classifier over CI logs would be a *second* opinion about a call the
 * first one already made — the arrangement `reliabilityInsights` refuses about
 * phases and `worldDiff` about CI status, for the same reason: two classifiers a
 * panel apart are free to disagree silently, and they disagree on exactly the
 * shapes that are hard.
 *
 * ## Two axes, not one taxonomy
 *
 * A cause and a preventability are different questions, and folding them into one
 * enum answers neither. "A stale test" says what was wrong; it does not say
 * whether anything available to the agent could have caught it — and that second
 * answer is the whole of *reduce them*. So every remedy carries a
 * {@link RemedyCause} (what was actually wrong) and a {@link RemedyGuard} (what
 * would have caught it before the push), and the panel ranks by both.
 *
 * The guard is where the loop closes. `undocumented` names something written down
 * nowhere, and what an agent does about that is `raise` it — one door, on the
 * board that keys and counts it (`docs/spec/27-obstacles.md`). This record carries
 * no claim of its own: a second writer of the same sentence, under a different
 * gate, is exactly the split the one door exists to close.
 *
 * ## Nothing gates on a remedy
 *
 * A pull request goes green whether or not anybody wrote up why it was red. A
 * missing remedy is therefore silence rather than a hold — rule `issue-retro`'s
 * fail-open, for its reason — and no rule, desk or gate reads this record. It
 * feeds two things and only two: a panel a person reads, and a note appended to a
 * later dispatch's prompt.
 */

import type { RemedyCause, RemedyGuard, RemedyKind } from '../types.js';

/**
 * What each cause means, in the words the tool description and the panel both
 * use. One copy, because an agent choosing from one wording and an operator
 * reading another is a taxonomy that means two different things.
 */
export const CAUSE_COPY: Record<RemedyCause, { label: string; blurb: string }> = {
  flake: { label: 'Flake', blurb: 'The same commit answers differently on a re-run — nothing in the diff' },
  environment: { label: 'Environment', blurb: 'The runner, a dependency, the network or a credential — not the diff' },
  inherited: { label: 'Inherited', blurb: 'Already red before this branch, or red from the base it sits on' },
  stale_test: { label: 'Stale test', blurb: 'The change was right; the test still encoded the old behaviour' },
  missed_gate: { label: 'Missed gate', blurb: 'The repository’s own check would have caught it, and it was not run' },
  contract_drift: {
    label: 'Contract drift',
    blurb: 'The change broke a caller, a type, or a second place the thing had to be registered',
  },
  missed_requirement: { label: 'Missed requirement', blurb: 'The ticket asked for it and the diff did not do it' },
  convention: { label: 'Convention', blurb: 'A house rule or repository idiom the agent did not know' },
  approach: { label: 'Approach', blurb: 'The reviewer wanted the problem solved a different way' },
  scope: { label: 'Scope', blurb: 'Too much, or too little, for what was asked' },
  docs: { label: 'Docs', blurb: 'The document that owns the behaviour was not updated with it' },
  clarity: { label: 'Clarity', blurb: 'Naming, comments or structure the reviewer could not read' },
  defect: { label: 'Defect', blurb: 'A genuine bug in the change' },
  other: { label: 'Other', blurb: 'None of the above — the summary carries it' },
};

/**
 * Which causes each kind may name.
 *
 * Split rather than shared because the two returns are genuinely different
 * animals: a review comment is never a flake, and a red check is never a matter
 * of taste. Offering an agent the whole union would put fourteen options in front
 * of a choice that has eight, and a taxonomy nobody can hold in mind is one where
 * everything lands on `other`.
 *
 * `defect` and `other` appear under both, deliberately and under one name: a bug
 * the suite caught and a bug a reviewer caught are the same fact about the fleet,
 * and two names for it would split the count that matters most.
 */
export const CAUSES_BY_KIND: Record<RemedyKind, readonly RemedyCause[]> = {
  ci: ['flake', 'environment', 'inherited', 'stale_test', 'missed_gate', 'contract_drift', 'defect', 'other'],
  review: ['missed_requirement', 'convention', 'approach', 'scope', 'docs', 'clarity', 'defect', 'other'],
};

/**
 * What would have caught it before the push — the axis that answers *reduce
 * them*, and the reason this is two enums rather than one.
 *
 * The four are ordered by what an operator can do about them, cheapest first, and
 * every surface keeps that order: run the gate, hand the agent what is already
 * written, write down what is not, or accept it. This constant *is* that order,
 * and both the tool description and the panel present the four by walking it.
 */
export const GUARD_ORDER: readonly RemedyGuard[] = ['local_check', 'documented', 'undocumented', 'unpreventable'];

export const GUARD_COPY: Record<RemedyGuard, { label: string; blurb: string }> = {
  local_check: {
    label: 'The local check',
    blurb: 'Running the repository’s own gate before pushing would have caught it',
  },
  documented: {
    label: 'Already written down',
    blurb: 'The rule exists in the repository and the agent did not read it',
  },
  undocumented: {
    label: 'Written down nowhere',
    blurb: 'Nothing available to the agent said this — the one an operator can fix',
  },
  unpreventable: {
    label: 'Nothing would have',
    blurb: 'A flake, the environment, or a judgement only the reviewer could make',
  },
};

const CAUSES = new Set<string>(Object.keys(CAUSE_COPY));

/**
 * The one line a person reads before deciding whether to open anything. Short for
 * `MAX_LESSON_CHARS`' reason: every safeguard on this surface rests on the row
 * having actually been read.
 */
const MAX_REMEDY_SUMMARY = 400;

/**
 * Which return this caller may account for, refusing every other origin **by name
 * and with the tool it actually wants** — the shape `retroSubmitOrigin` uses, for
 * its reason.
 *
 * The kind and the pull request both come out of the origin rather than out of an
 * argument, so a CI agent cannot file a review remedy and no agent can file
 * against another pull request. That is the channel's one structural guarantee,
 * and here it is also what makes the counts worth anything: a `kind` an agent
 * could assert is a column reporting whatever each agent took it to mean.
 */
export function remedyOrigin(
  originRef: string | null,
): { ok: true; kind: RemedyKind; prNumber: number; originRef: string } | { ok: false; error: string } {
  const match = originRef ? /^pr:(\d+):(ci|comments)$/.exec(originRef) : null;
  if (match) {
    return { ok: true, kind: match[2] === 'ci' ? 'ci' : 'review', prNumber: Number(match[1]), originRef: originRef! };
  }
  return {
    ok: false,
    error:
      `report_remedy is only for an agent dispatched to answer a pull request's failing CI or its ` +
      `review threads, and this task's origin is ${originRef ?? '(none)'}. If you are finishing work on ` +
      `an issue, use conclude_work; if you are writing up a goal, use retro_submit; if you noticed ` +
      `something that is not your task at all, use raise.`,
  };
}

/**
 * The ask, appended to every CI-fix and review dispatch.
 *
 * **Appended, never interpolated**, and unconditionally — the two things that
 * make this reliable. `pr-ci-fix` and `pr-review-comment` are operator-
 * overridable and `loadPromptTemplates` rejects only *unknown* placeholders, so a
 * `{remedy}` token would be silently dropped by every override written before
 * this existed. And it renders whether or not there is any prior record, unlike
 * `priorCiRemediesNote` — the account is the thing being asked for, so a fleet
 * with nothing recorded yet is exactly the fleet that most needs the ask.
 *
 * A tool description alone was not enough here. `report_remedy` is classified
 * `point-of-use` in `test/mcpChannel.test.ts` precisely because only two kinds of
 * agent ever call it, and a tool named nowhere but in `tools/list` is a tool an
 * agent finishes without.
 */
export function remedyAskNote(kind: RemedyKind): string {
  const subject = kind === 'ci' ? 'why CI was red' : 'why the reviewer asked for changes';
  return (
    `\n\n---\n\nBefore you finish, call \`report_remedy\` to say ${subject} and what settled it. ` +
    `Two enums and a line — it takes a moment, and it is the only record anywhere of *why* the ` +
    `fleet keeps coming back to pull requests. It schedules nothing and changes nothing about your ` +
    `work; answer the "what would have caught it" half honestly even when the answer is unflattering.\n`
  );
}

/** A validated submission, ready for the store. */
export interface RemedySubmission {
  cause: RemedyCause;
  guard: RemedyGuard;
  summary: string;
}

/**
 * What a submission is allowed to be.
 *
 * Three fields and no fourth: what came back, what would have caught it, and one
 * line saying what was wrong. Anything the run taught that outlives the pull
 * request goes through `raise`, which is the one door and the only one that keys
 * and counts what it is handed.
 */
export function validateRemedy(
  kind: RemedyKind,
  raw: unknown,
): { ok: true; submission: RemedySubmission } | { ok: false; error: string } {
  const args = (raw ?? {}) as Record<string, unknown>;
  const cause = typeof args.cause === 'string' ? args.cause : '';
  const allowed = CAUSES_BY_KIND[kind];
  if (!CAUSES.has(cause) || !allowed.includes(cause as RemedyCause)) {
    // One refusal for "not a cause" and "not a cause *this* kind can have",
    // because the agent's next move is identical either way: pick from the list,
    // which is named rather than alluded to.
    return {
      ok: false,
      error: `cause must be one of ${allowed.join(', ')} for a ${kind === 'ci' ? 'CI failure' : 'review round'}`,
    };
  }
  const guard = typeof args.guard === 'string' ? args.guard : '';
  if (!GUARD_ORDER.includes(guard as RemedyGuard)) {
    return { ok: false, error: `guard must be one of ${GUARD_ORDER.join(', ')}` };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (summary.length === 0) {
    return { ok: false, error: 'summary is required — one line: what was wrong, and what fixed it' };
  }
  if (summary.length > MAX_REMEDY_SUMMARY) {
    return { ok: false, error: `summary must be ${MAX_REMEDY_SUMMARY} characters or fewer` };
  }
  return {
    ok: true,
    submission: {
      cause: cause as RemedyCause,
      guard: guard as RemedyGuard,
      summary,
    },
  };
}
