import { issueOriginId } from '../issueOrigins.js';
import { HUMAN_NOTE } from './prFooter.js';
import { SIGNOFF_MARKER } from '../sink/signOff.js';
import type { DescriptionQuestion, PrDescriptionVersion } from '../types.js';

// → docs/spec/07-pull-requests.md#the-operator-writes-the-description

export const PR_DESCRIPTION = {
  /**
   * A bound, not a shape. The field holds prose and nothing here says what shape the
   * prose takes — but a route that accepts an unbounded string accepts a megabyte,
   * and the body of a pull request is not where that belongs.
   */
  maxChars: 4000,
} as const;

/**
 * The four questions, as they are put to the operator.
 *
 * The four a reviewer has to be able to answer for themselves, put in prose to the
 * person who will answer for the change.
 *
 * They are **hints and never fields**. Four boxes make the form the task — an
 * operator fills each one because it is there, and a question with nothing to say
 * under it gets an answer anyway. As hints they do the only job worth doing: an
 * operator who cannot answer one notices before a reviewer does.
 */
export const DESCRIPTION_PROMPTS: Readonly<Record<DescriptionQuestion, string>> = {
  'asked-for': 'Is this what we asked for?',
  undone: 'What can’t be undone if this is wrong?',
  missing: 'What’s missing?',
  reach: 'How far does it reach if it’s wrong?',
};

/**
 * What a description is refused for, or null.
 *
 * Deliberately almost nothing. `prBodyRefusal` asserts a bullet list, a length cap
 * per line and a reading-ease floor, and it exists because asking an agent for a
 * shape did not work: asked for five bullets, agents wrote five paragraphs with a
 * dash in front of each. A person writing about a change they read is not that
 * party. A refusal that bounced their prose for a semicolon would teach them to
 * write for the checker, which is the one thing this field must not do — the value
 * is in what the writing makes them notice, and nothing about a Flesch score is
 * about that.
 *
 * So: it must not be empty, and it must fit. Everything else is theirs.
 */
export function descriptionRefusal(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '')
    return 'a description with nothing in it is not a description — say what the change does, or save nothing';
  if (trimmed.length > PR_DESCRIPTION.maxChars)
    return (
      `a description runs ${trimmed.length} characters and the limit is ${PR_DESCRIPTION.maxChars}. This is the ` +
      'body of a pull request, not the document behind it.'
    );
  return null;
}

/**
 * How a checked description stood, as one word for a surface to draw.
 *
 * Derived from the findings rather than stored, so there is no second record to
 * disagree with the first. `contradicted` outranks `gaps` wherever both are present:
 * a false sentence under a person's name is what a reader has to be told first, and
 * a description that also left something out is still primarily one that says
 * something untrue. → docs/spec/07-pull-requests.md#it-contradicts-it-never-drafts
 */
export function descriptionStanding(version: PrDescriptionVersion): 'unchecked' | 'clean' | 'gaps' | 'contradicted' {
  if (version.checkedAt === null) return 'unchecked';
  if (version.findings.some((f) => f.kind === 'contradicted')) return 'contradicted';
  if (version.findings.length > 0) return 'gaps';
  return 'clean';
}

/**
 * The body a described pull request carries: the operator's text, the mark saying a
 * person wrote it, then the footer `open_pr` recorded.
 *
 * Composed rather than patched, so a rewrite re-derives the whole body from the newest
 * version and the stored footer. The mark is what makes the description's whole point
 * legible: a reviewer weighs an account by who wrote it, and the footer below says the
 * pull request is the harness's — which would name the wrong author for the prose above
 * it. Either half being empty leaves the other alone, and the mark goes with the half it
 * labels: a mark over nothing labels an author who wrote nothing.
 * → docs/spec/07-pull-requests.md#it-is-written-against-an-open-pull-request-never-before-one
 */
export function composeDescribedBody(text: string, tail: string): string {
  const head = text.trim();
  const rest = tail.trim();
  if (head === '') return rest;
  const described = [head, HUMAN_NOTE].join('\n\n');
  if (rest === '') return described;
  return [described, rest].join('\n\n');
}

/**
 * The description a live pull request body carries above the harness's footer, or null
 * for a body with nothing above it.
 *
 * The inverse of `composeDescribedBody`, so a body the harness wrote reads back as the
 * text it was composed from — which is what keeps the desk from adopting its own push.
 * The footer is found by the tail `open_pr` recorded; failing that, by the rule above
 * the sign-off marker, because a provider or a person may have reflowed the rest of it.
 * → docs/spec/07-pull-requests.md#a-description-written-on-the-provider-is-adopted
 */
export function descriptionInBody(live: string, tail: string): string | null {
  const body = normaliseBody(live);
  const footer = normaliseBody(tail);
  let head = body;
  const at = footer === '' ? -1 : body.lastIndexOf(footer);
  if (at >= 0) head = body.slice(0, at);
  else {
    const marker = body.indexOf(SIGNOFF_MARKER);
    if (marker >= 0) {
      const rule = body.lastIndexOf('---', marker);
      head = body.slice(0, rule >= 0 ? rule : marker);
    }
  }
  head = head.trim();
  if (head.endsWith(HUMAN_NOTE)) head = head.slice(0, -HUMAN_NOTE.length).trim();
  return head === '' ? null : head;
}

/** Line endings and trailing spaces are the provider's, never the writer's. */
export function normaliseBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** The read-only checkout rule `pr-describe` reads a pull request's diff from. */
export function describeBranch(prNumber: number): string {
  return `describe/pr/${prNumber}`;
}

/** The read-only checkout rule `pr-description-check` reads a pull request's diff from. */
export function describeCheckBranch(prNumber: number): string {
  return `describe-check/pr/${prNumber}`;
}

/** The pull request a `pr-description-check` dispatch was sent for, or null for any other origin. */
export function describeCheckTargetPr(originRef: string | null): number | null {
  const check = issueOriginId('describeCheck', originRef);
  return check === null ? null : Number(check.id);
}

/** The pull request a `pr-describe` dispatch was sent for, or null for any other origin. */
export function describeTargetPr(originRef: string | null): number | null {
  const describe = issueOriginId('describe', originRef);
  return describe === null ? null : Number(describe.id);
}
