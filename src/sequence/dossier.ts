import type { Issue } from '../types.js';
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
export function sequenceBriefing(originRef: string | null | undefined, issues: readonly Issue[]): string | null {
  const target = originRef ? featureSequenceSubmitOrigin(originRef) : { ok: false as const, error: '' };
  if (!target.ok) return null;
  const children = issues
    .filter((issue) => issue.parent?.number === target.featureNumber && issue.state === 'open')
    .sort((a, b) => a.number - b.number);
  if (children.length === 0) return null;

  const feature = children[0]!.parent!;
  const lines = [
    `## Feature #${feature.number} — ${feature.title}`,
    feature.body ? feature.body.trim() : '_The Feature carries no description._',
    '',
    `## Its ${children.length} open stories`,
  ];
  for (const child of children) {
    lines.push('', `### #${child.number} — ${child.title}`);
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
  return lines.join('\n');
}
