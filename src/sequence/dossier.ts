import type { FeatureSequence, Issue } from '../types.js';
import { featureSequenceSubmitOrigin } from './sequence.js';

// → docs/spec/33-story-sequencing.md

const MAX_BODY = 1_200;

export function sequenceBriefing(
  originRef: string | null | undefined,
  issues: readonly Issue[],
  standing: FeatureSequence | null = null,
): string | null {
  const target = originRef ? featureSequenceSubmitOrigin(originRef) : { ok: false as const, error: '' };
  if (!target.ok) return null;
  const children = issues
    .filter((issue) => issue.parent?.number === target.featureNumber && issue.state === 'open')
    .sort((a, b) => a.number - b.number);
  if (children.length === 0) return null;

  const feature = children[0]!.parent!;
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
