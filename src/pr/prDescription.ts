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
 * The same four a reviewer has to be able to answer, which `renderEvidence` already
 * takes off the agent and turns into coordinates. Asked here in prose, of the person
 * who will answer for the change.
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
