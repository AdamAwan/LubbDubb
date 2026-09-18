import { DESCRIPTION_QUESTIONS } from '../store/prDescriptions.js';
import type { DescriptionMark, DescriptionQuestion, PrDescriptionVersion } from '../types.js';

// → docs/spec/18-observability.md#how-a-description-stood

/**
 * What the aggregate is allowed to see of a description: which questions were
 * marked, and how. **Never the text, and never the author.**
 *
 * The author column is dropped for the reason `predictionAggregate` drops it —
 * scoring people is out of scope, so the author-grouped filter a later change would
 * reach for has nothing here to group by. The text is dropped for a weaker reason
 * than a prediction's containment, because a description is published and reading it
 * leaks nothing: it is dropped so that no panel downstream can quote an operator
 * back at themselves. Both are the invariant made structural rather than promised.
 */
interface DescriptionFacts {
  originRef: string;
  marks: Readonly<Record<DescriptionQuestion, DescriptionMark | null>>;
}

/** The one door a `PrDescriptionVersion` comes through on its way to a figure. */
function descriptionFacts(version: PrDescriptionVersion): DescriptionFacts {
  return { originRef: version.originRef, marks: version.marks };
}

/**
 * How one question has stood across every checked description.
 *
 * `contradicted` has a count of its own and is never folded into `missed`. They are
 * not the same defect: a question nobody answered leaves a reviewer to find out for
 * themselves, and a contradicted one ships a false sentence under a person's name.
 * A single "wrong" column would bury the second inside the first, which is exactly
 * the reading this aggregate exists to surface.
 * → docs/spec/07-pull-requests.md#four-marks-because-a-description-can-fail-two-ways
 */
interface DescriptionQuestionCount {
  question: DescriptionQuestion;
  matched: number;
  missed: number;
  contradicted: number;
  notApplicable: number;
}

interface DescriptionAggregate {
  /** Descriptions with a check on them. The n every count below is over. */
  checked: number;
  /**
   * Descriptions whose check found at least one contradiction, which is the figure
   * worth reading on its own: it counts pull requests that would have carried a
   * false sentence into a review.
   */
  withContradiction: number;
  questions: DescriptionQuestionCount[];
  /**
   * Below `threshold` the counts are withheld and this carries the n instead, the
   * shape `PredictionRate` already uses — a rate over four descriptions is noise
   * wearing a percentage, and the panel's whole posture is not to draw one.
   */
  belowThreshold: boolean;
}

/**
 * The fold. Every version handed in carries a check; `listCheckedDescriptions` is
 * what decides that, so nothing here re-asks it.
 */
export function buildDescriptionAggregate(
  versions: readonly PrDescriptionVersion[],
  threshold: number,
): DescriptionAggregate {
  const facts = versions.map(descriptionFacts);
  const questions: DescriptionQuestionCount[] = DESCRIPTION_QUESTIONS.map((question) => ({
    question,
    matched: 0,
    missed: 0,
    contradicted: 0,
    notApplicable: 0,
  }));
  let withContradiction = 0;

  for (const fact of facts) {
    let contradicted = false;
    for (const [i, question] of DESCRIPTION_QUESTIONS.entries()) {
      const mark = fact.marks[question];
      const row = questions[i]!;
      if (mark === 'matched') row.matched += 1;
      else if (mark === 'missed') row.missed += 1;
      else if (mark === 'contradicted') {
        row.contradicted += 1;
        contradicted = true;
      } else if (mark === 'not-applicable') row.notApplicable += 1;
    }
    if (contradicted) withContradiction += 1;
  }

  const belowThreshold = facts.length < threshold;
  return {
    checked: facts.length,
    withContradiction: belowThreshold ? 0 : withContradiction,
    questions: belowThreshold ? [] : questions,
    belowThreshold,
  };
}
