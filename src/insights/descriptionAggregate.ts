import { descriptionStanding } from '../pr/prDescription.js';
import type { DescriptionQuestion, PrDescriptionVersion } from '../types.js';

// → docs/spec/18-observability.md#how-a-description-stood

/**
 * What the aggregate is allowed to see of a description: how it stood, and which of
 * the four questions its findings happened to name. **Never the text, never a
 * finding's note, and never the author.**
 *
 * The author column is dropped for the reason `predictionAggregate` drops it —
 * scoring people is out of scope, so the author-grouped filter a later change would
 * reach for has nothing here to group by. The prose is dropped so that no panel
 * downstream can quote either the operator or the session that checked them back at
 * anybody; the aggregate is a count of how often the account and the code agreed,
 * and it needs no sentence to say that.
 */
interface DescriptionFacts {
  originRef: string;
  stood: ReturnType<typeof descriptionStanding>;
  questionsRaised: readonly DescriptionQuestion[];
}

/** The one door a `PrDescriptionVersion` comes through on its way to a figure. */
function descriptionFacts(version: PrDescriptionVersion): DescriptionFacts {
  return {
    originRef: version.originRef,
    stood: descriptionStanding(version),
    questionsRaised: version.findings.flatMap((f) => (f.question === null ? [] : [f.question])),
  };
}

interface DescriptionAggregate {
  /** Descriptions with a check on them. The n every count below is over. */
  checked: number;
  /** Checked and nothing found. A real outcome, and not the same as never checked. */
  clean: number;
  /**
   * Checks that found the description asserting something the diff does not do. The
   * figure worth reading on its own: it counts the pull requests that would have
   * carried a false sentence into somebody's review.
   */
  contradicted: number;
  /** Checks whose findings were all gaps — something the diff raises and the description does not. */
  gaps: number;
  /**
   * How often each of the four questions was the thing a finding named. A weak
   * signal deliberately placed last: the questions are hints under the field rather
   * than the shape of a check, most findings name none of them, and a panel that led
   * with this would be reporting on the four things a check is *not* keyed by.
   */
  questionsRaised: { question: DescriptionQuestion; count: number }[];
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
  const raised = new Map<DescriptionQuestion, number>();
  let clean = 0;
  let contradicted = 0;
  let gaps = 0;

  for (const fact of facts) {
    if (fact.stood === 'clean') clean += 1;
    else if (fact.stood === 'contradicted') contradicted += 1;
    else if (fact.stood === 'gaps') gaps += 1;
    for (const question of new Set(fact.questionsRaised)) raised.set(question, (raised.get(question) ?? 0) + 1);
  }

  const belowThreshold = facts.length < threshold;
  return {
    checked: facts.length,
    clean: belowThreshold ? 0 : clean,
    contradicted: belowThreshold ? 0 : contradicted,
    gaps: belowThreshold ? 0 : gaps,
    questionsRaised: belowThreshold
      ? []
      : [...raised.entries()]
          .map(([question, count]) => ({ question, count }))
          .sort((a, b) => b.count - a.count || a.question.localeCompare(b.question)),
    belowThreshold,
  };
}
