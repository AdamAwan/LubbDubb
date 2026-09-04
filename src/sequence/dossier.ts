import type { FeatureSequence, Issue } from '../types.js';
import { featureSequenceSubmitOrigin } from './sequence.js';

/** How much of a story's own text rides in the dossier. Past this it stops being read. */
const MAX_BODY = 1_200;

/**
 * What the sequencer is shown: the Feature's goal, and every story under it with
 * its own text and whatever order the board already states.
 *
 * **Appended to the rendered prompt, never interpolated.** Templates are
 * operator-overridable and `loadPromptTemplates` rejects only _unknown_
 * placeholders, so an override written before this existed would drop an
 * interpolated `{stories}` in silence — on exactly the deployments that customised
 * most, and leaving an agent asked to order a list it was never given.
 * → [09](../../docs/spec/09-execution.md)
 *
 * The Predecessor links are drawn **as the board's own**, marked as such, because
 * an agent that could not tell them from its own guesses would restate them as
 * inferences — and the whole point of recording provenance is lost one layer
 * earlier, before an operator ever sees the card.
 *
 * Null for a caller that is not a sequencer, or a Feature the world does not hold:
 * the prompt then carries nothing extra, and the agent's own refusal to order what
 * it cannot see is the correct outcome.
 */
export function sequenceBriefing(
  originRef: string | null | undefined,
  issues: readonly Issue[],
  /**
   * The order on file, if any. Passed rather than looked up so this stays pure
   * over what it is handed — the caller owns the store, and a briefing that read
   * one would be a second reader of a record the rule already compares a key
   * against.
   */
  standing: FeatureSequence | null = null,
): string | null {
  const target = originRef ? featureSequenceSubmitOrigin(originRef) : { ok: false as const, error: '' };
  if (!target.ok) return null;
  const children = issues
    .filter((issue) => issue.parent?.number === target.featureNumber && issue.state === 'open')
    .sort((a, b) => a.number - b.number);
  if (children.length === 0) return null;

  const feature = children[0]!.parent!;
  // Which stories the standing order has never seen. Empty where there is no
  // order, and empty where the row predates the membership column — in both cases
  // nothing is marked, which reads as "work it out from the list", the behaviour
  // before any of this existed.
  const covered = new Set(standing?.members ?? []);
  const fresh =
    standing?.members == null
      ? new Set<number>()
      : new Set(children.map((c) => c.number).filter((n) => !covered.has(n)));
  const lines = [
    `## Feature #${feature.number} — ${feature.title}`,
    feature.body ? feature.body.trim() : '_The Feature carries no description._',
    '',
    `## Its ${children.length} open stories`,
  ];
  for (const child of children) {
    lines.push('', `### #${child.number} — ${child.title}${fresh.has(child.number) ? ' — **new**' : ''}`);
    if (child.issueType) lines.push(`_${child.issueType}${child.workItemState ? ` · ${child.workItemState}` : ''}_`);
    const stated = (child.dependsOn ?? []).filter((d) => children.some((c) => c.number === d.number));
    if (stated.length > 0) {
      lines.push(
        `**The board already states** that this waits on ${stated.map((d) => `#${d.number}`).join(', ')}. ` +
          'Somebody drew that link; it is not yours to contradict, and you do not need to restate it.',
      );
    }
    lines.push(child.body ? child.body.trim().slice(0, MAX_BODY) : '_No description._');
  }
  if (standing !== null && standing.status !== 'declined') {
    lines.push('', ...standingOrder(standing, fresh));
  }
  return lines.join('\n');
}

/**
 * The order that already stands, so a re-sequence revises rather than restarts —
 * `currentPlanSummary`'s job for a replan (`src/plans/parts.ts`), and for its
 * reason: without it the agent re-derives from scratch and gives the same
 * decisions different answers, which for a plan strands in-flight parts and here
 * puts a judgement somebody already made back in front of them.
 *
 * A `declined` order is deliberately not shown. It is not an order the operator
 * holds, it is them saying to run the stories in parallel, and quoting it as
 * something to preserve would invite exactly the edges they refused.
 */
function standingOrder(standing: FeatureSequence, fresh: ReadonlySet<number>): string[] {
  const lines = [
    standing.status === 'accepted'
      ? '## The order that stands — accepted, and holding work now'
      : '## The order proposed last time — nobody has answered it',
    '',
    standing.reason,
  ];
  if (standing.edges.length === 0) {
    lines.push('', 'It states no edges at all: whoever wrote it found these stories independent.');
  } else {
    lines.push('');
    for (const edge of standing.edges) {
      lines.push(`- #${edge.issue} waits on #${edge.dependsOn}${edge.reason === null ? '' : ` — ${edge.reason}`}`);
    }
  }
  if (fresh.size > 0) {
    lines.push(
      '',
      `It was written before ${[...fresh].map((n) => `#${n}`).join(', ')}, which is what you are being asked about.`,
    );
  }
  return lines;
}
