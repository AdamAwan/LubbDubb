import type { FeatureSequence, Issue, PullRequest } from '../types.js';
import { featureSequenceOrigin, featureSequenceSubmitOrigin } from './sequence.js';
import { sequenceReadiness } from './readiness.js';

// → docs/spec/33-story-sequencing.md

const MAX_BODY = 1_200;

const MAX_STORIES = 40;

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
  const dropped = Math.max(0, children.length - MAX_STORIES);
  const shown = dropped > 0 ? children.slice(0, MAX_STORIES) : children;
  const lines = [
    `## Feature #${feature.number} — ${feature.title}`,
    feature.body ? feature.body.trim() : '_The Feature carries no description._',
    '',
    `## Its ${children.length} open stories`,
  ];
  if (dropped > 0) {
    lines.push(
      '',
      `(${dropped} of the ${children.length} stories are not shown here — the highest-numbered went first. ` +
        'Order the ones you were given and say nothing about the rest.)',
    );
  }
  for (const child of shown) {
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

const MAX_SIBLINGS_NAMED = 12;

/**
 * What the appraiser is told about work this story expects to arrive from elsewhere. The hold
 * covers a declared predecessor; this covers the one nobody has declared yet.
 * → docs/spec/33-story-sequencing.md#what-the-appraiser-is-told
 */
export function predecessorNote(
  issue: Issue,
  issues: readonly Issue[],
  sequences: ReadonlyMap<string, FeatureSequence>,
  openPrs: readonly PullRequest[],
): string {
  const parent = issue.parent;
  if (!parent) return '';
  const siblings = issues.filter(
    (i) => i.parent?.number === parent.number && i.number !== issue.number && i.state === 'open',
  );
  if (siblings.length === 0) return '';

  const standing = sequences.get(featureSequenceOrigin(parent.number)) ?? null;
  const proposed =
    standing !== null && standing.status === 'proposed'
      ? standing.edges.map((e) => ({ issue: e.issue, dependsOn: e.dependsOn }))
      : [];
  const waiting = sequenceReadiness(proposed, { issues, openPrs: [...openPrs] }).get(issue.number) ?? [];

  const lines =
    waiting.length > 0
      ? [
          `An order proposed for Feature #${parent.number} — which nobody has accepted, so it is holding nothing and ` +
            `you were dispatched anyway — has this story waiting on ${waiting.map((n) => `#${n}`).join(', ')}. ` +
            `${waiting.length === 1 ? 'It has' : 'None of them has'} landed, so whatever ` +
            `${waiting.length === 1 ? 'it was' : 'they were'} going to build is not in the checkout you are reading.`,
        ]
      : [
          `This story is one of ${siblings.length + 1} open under Feature #${parent.number}, and nobody has put them ` +
            `in an order. Something this ticket names may be another story's to build rather than this one's.`,
          ...(siblings.length <= MAX_SIBLINGS_NAMED
            ? [`Those are: ${siblings.map((s) => `#${s.number}`).join(', ')}.`]
            : []),
        ];

  lines.push(
    'Work that has not happened yet is not a gap in the ticket. You are judging whether the author said enough for ' +
      'somebody to start — `unclear` is for a ticket you cannot tell "done" from "not done" for, one that ' +
      'contradicts itself, or one that contradicts something already true of the code. A ticket that reads clearly ' +
      'and names something a sibling story is going to build is **workable**: say in your summary what you took to ' +
      'be arriving from elsewhere, so a wrong reading is visible before an agent acts on it. Mark it `unclear` over ' +
      'a dependency only when the ticket does not say enough for you to tell what it expects that dependency to ' +
      'provide.',
    'If you conclude this story has to wait for another, say so on the scratchpad and name it. Nothing here reads ' +
      'your verdict as an order and you cannot draw one, but it is what an operator needs in order to.',
  );

  return `\n\nWhat this story may be waiting on:\n\n${lines.join('\n\n')}`;
}
