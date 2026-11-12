import { isContainerIssue, storiesUnder } from '../issueRelations.js';
import type { Store } from '../store/store.js';
import type { DiscussionDocument, DiscussionSubjectKind, Issue } from '../types.js';
import type { DiscussionFiles, DiscussionSubject } from './discussionFile.js';
import { discussionParent, memoReader, type DiscussionReader } from './reader.js';

// → docs/spec/40-discussions.md#the-file

export interface ResolvedSubject {
  kind: DiscussionSubjectKind | null;
  title: string | null;
  parent: { number: number; title: string } | null;
  stories: Issue[];
}

export function resolveSubject(
  issues: readonly Issue[],
  issueNumber: number,
  containerTypes: readonly string[] | undefined,
  doc: DiscussionDocument | null = null,
): ResolvedSubject {
  const issue = issues.find((i) => i.number === issueNumber) ?? null;
  const feature = isFeature(issues, issue, doc, containerTypes);
  const parent = feature ? null : parentOf(issues, issueNumber, issue, doc);
  const story = issue !== null || parent !== null;
  return {
    kind: feature ? 'feature' : story ? 'story' : (doc?.frontMatter.kind ?? null),
    title: issue?.title ?? doc?.frontMatter.title ?? null,
    parent,
    stories: feature ? storiesUnder(issues, issueNumber) : [],
  };
}

function isFeature(
  issues: readonly Issue[],
  issue: Issue | null,
  doc: DiscussionDocument | null,
  containerTypes: readonly string[] | undefined,
): boolean {
  if (issue === null) return doc?.frontMatter.kind === 'feature';
  if (isContainerIssue(issue, containerTypes)) return true;
  return !issue.issueType && !issue.parent && storiesUnder(issues, issue.number).length > 0;
}

function parentOf(
  issues: readonly Issue[],
  issueNumber: number,
  issue: Issue | null,
  doc: DiscussionDocument | null,
): ResolvedSubject['parent'] {
  const number = discussionParent(issueNumber, issue?.parent?.number ?? null, doc);
  if (number === null) return null;
  const title = issue?.parent?.number === number ? issue.parent.title : issues.find((i) => i.number === number)?.title;
  return { number, title: title ?? '' };
}

/** An issue the world does not hold is a story with no title. */
export function discussionSubject(
  issues: readonly Issue[],
  issueNumber: number,
  containerTypes: readonly string[] | undefined,
): DiscussionSubject {
  const subject = resolveSubject(issues, issueNumber, containerTypes);
  return { number: issueNumber, title: subject.title ?? '', kind: subject.kind ?? 'story', parent: subject.parent };
}

/**
 * The subject a write from outside the fleet names — the operator's Claude, a cockpit press — refused for a
 * number the world does not list and no discussion file holds, rather than filed as an untitled story.
 */
export function knownDiscussionSubject(
  files: Pick<DiscussionFiles, 'locate'>,
  issues: readonly Issue[],
  issueNumber: number,
  containerTypes: readonly string[] | undefined,
): { ok: true; subject: DiscussionSubject } | { ok: false; error: string } {
  if (!issues.some((i) => i.number === issueNumber) && files.locate(issueNumber) === null) {
    return {
      ok: false,
      error:
        `The harness holds nothing about #${String(issueNumber)}: the last world snapshot does not list it and it ` +
        'has no discussion file. Check the number, or that the ticket carries the watch tag.',
    };
  }
  return { ok: true, subject: discussionSubject(issues, issueNumber, containerTypes) };
}

export function fleetDiscussions(
  files: DiscussionFiles,
  store: Store,
  containerTypes: readonly string[] | undefined,
): { files: DiscussionFiles; subject: (issueNumber: number) => DiscussionSubject } {
  return {
    files,
    subject: (issueNumber) =>
      discussionSubject(store.world.getWorldBaseline()?.issues ?? [], issueNumber, containerTypes),
  };
}

/** What the pulse hands the dispatcher about each goal, fresh each pulse; absent where discussions are off. → docs/spec/40-discussions.md#what-agents-read */
export interface GoalIntake {
  discussion?: DiscussionReader;
}

export function discussionIntake(files: DiscussionFiles): GoalIntake {
  return files.enabled ? { discussion: memoReader((n) => files.read(n)) } : {};
}
