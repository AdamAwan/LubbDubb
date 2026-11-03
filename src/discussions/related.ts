import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DiscussionDocument, DiscussionSubjectKind, Issue } from '../types.js';
import type { DiscussionNeighbour, DiscussionReading } from '../wire.js';
import type { DiscussionFiles } from './discussionFile.js';
import { openQuestions, standingDecisions } from './entries.js';

// → docs/spec/40-discussions.md#in-the-cockpit

interface Subject {
  kind: DiscussionSubjectKind | null;
  parent: number | null;
  stories: Issue[];
  title: string | null;
}

function subjectOf(issues: readonly Issue[], number: number, doc: DiscussionDocument | null): Subject {
  const self = issues.find((i) => i.number === number);
  const stories = issues.filter((i) => i.parent?.number === number);
  const parent = self?.parent?.number ?? doc?.frontMatter.parentNumber ?? null;
  const kind = parent !== null ? 'story' : stories.length > 0 ? 'feature' : (doc?.frontMatter.kind ?? null);
  return { kind, parent, stories, title: self?.title ?? doc?.frontMatter.title ?? null };
}

export function readDiscussion(
  discussions: Pick<DiscussionFiles, 'enabled' | 'read'>,
  issues: readonly Issue[],
  number: number,
): DiscussionReading {
  const doc = discussions.read(number);
  const subject = subjectOf(issues, number, doc);
  return {
    enabled: discussions.enabled,
    number,
    kind: subject.kind,
    title: subject.title,
    path: doc?.path ?? null,
    obsidianUrl: doc === null ? null : obsidianUrl(doc.path),
    entries: doc?.entries ?? [],
    related: discussions.enabled ? related(discussions, issues, subject) : [],
  };
}

function related(
  discussions: Pick<DiscussionFiles, 'read'>,
  issues: readonly Issue[],
  subject: Subject,
): DiscussionNeighbour[] {
  const near =
    subject.kind === 'story' && subject.parent !== null
      ? [neighbour(discussions, subject.parent, 'feature', issues)]
      : subject.kind === 'feature'
        ? subject.stories.map((s) => neighbour(discussions, s.number, 'story', issues))
        : [];
  return near.filter(
    (n): n is DiscussionNeighbour => n !== null && n.standingDecisions.length + n.openQuestions.length > 0,
  );
}

function neighbour(
  discussions: Pick<DiscussionFiles, 'read'>,
  number: number,
  kind: DiscussionSubjectKind,
  issues: readonly Issue[],
): DiscussionNeighbour | null {
  const doc: DiscussionDocument | null = discussions.read(number);
  if (doc === null) return null;
  return {
    number,
    title: issues.find((i) => i.number === number)?.title ?? doc.frontMatter.title,
    kind,
    path: doc.path,
    obsidianUrl: obsidianUrl(doc.path),
    standingDecisions: standingDecisions(doc.entries),
    openQuestions: openQuestions(doc.entries),
  };
}

function obsidianUrl(path: string): string | null {
  let dir = dirname(path);
  for (;;) {
    const marker = join(dir, '.obsidian');
    if (existsSync(marker) && statSync(marker).isDirectory()) {
      return `obsidian://open?path=${encodeURIComponent(path)}`;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
