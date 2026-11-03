import type { DiscussionFrontMatter, DiscussionSubjectKind, Issue } from '../types.js';
import type { DiscussionNeighbour, DiscussionReading } from '../wire.js';
import type { DiscussionFiles } from './discussionFile.js';
import { openQuestions, standingDecisions } from './entries.js';
import { discussionPair } from './reader.js';
import { resolveSubject } from './subject.js';

// → docs/spec/40-discussions.md#in-the-cockpit

type Files = Pick<DiscussionFiles, 'enabled' | 'read' | 'obsidianUrl'>;

export function readDiscussion(
  discussions: Files,
  issues: readonly Issue[],
  number: number,
  containerTypes: readonly string[] | undefined,
): { reading: DiscussionReading; frontMatter: DiscussionFrontMatter | null } {
  const read = (n: number): ReturnType<Files['read']> => discussions.read(n);
  const self = issues.find((i) => i.number === number);
  const { story: doc, feature } = discussionPair(read, number, self?.parent?.number ?? null);
  const subject = resolveSubject(issues, number, containerTypes, doc);
  const near =
    subject.kind === 'story' && subject.parent !== null
      ? [neighbour(discussions, feature, subject.parent.number, 'feature', issues)]
      : subject.stories.map((s) => neighbour(discussions, read(s.number), s.number, 'story', issues));
  return {
    reading: {
      enabled: discussions.enabled,
      number,
      kind: subject.kind,
      title: subject.title,
      path: doc?.path ?? null,
      obsidianUrl: doc === null ? null : discussions.obsidianUrl(doc.path),
      entries: doc?.entries ?? [],
      related: near.filter(
        (n): n is DiscussionNeighbour => n !== null && n.standingDecisions.length + n.openQuestions.length > 0,
      ),
    },
    frontMatter: doc?.frontMatter ?? null,
  };
}

function neighbour(
  discussions: Files,
  doc: ReturnType<Files['read']>,
  number: number,
  kind: DiscussionSubjectKind,
  issues: readonly Issue[],
): DiscussionNeighbour | null {
  if (doc === null) return null;
  return {
    number,
    title: issues.find((i) => i.number === number)?.title ?? doc.frontMatter.title,
    kind,
    path: doc.path,
    obsidianUrl: discussions.obsidianUrl(doc.path),
    standingDecisions: standingDecisions(doc.entries),
    openQuestions: openQuestions(doc.entries),
  };
}
