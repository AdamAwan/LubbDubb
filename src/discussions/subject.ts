import { isContainerIssue } from '../issueRelations.js';
import type { Store } from '../store/store.js';
import type { Issue } from '../types.js';
import type { DiscussionFiles, DiscussionSubject } from './discussionFile.js';
import { memoReader, type DiscussionReader } from './questionHold.js';

// → docs/spec/40-discussions.md#what-fleet-agents-write

/** What a first write to issue `n`'s file is headed with. An issue the world does not hold is a story with no title. */
function discussionSubject(
  issues: readonly Issue[],
  issueNumber: number,
  containerTypes: readonly string[] | undefined,
): DiscussionSubject {
  const issue = issues.find((i) => i.number === issueNumber);
  if (issue === undefined) return { number: issueNumber, title: '', kind: 'story' };
  const feature = isContainerIssue(issue, containerTypes);
  return {
    number: issueNumber,
    title: issue.title,
    kind: feature ? 'feature' : 'story',
    parent: feature || !issue.parent ? null : { number: issue.parent.number, title: issue.parent.title },
  };
}

/** `McpToolDeps.discussions`: the files, and a subject resolved against the stored world. */
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

/** The pulse's reader, fresh each pulse; nothing where discussions are off. → docs/spec/40-discussions.md#what-agents-read */
export function discussionIntake(files: DiscussionFiles): { discussion?: DiscussionReader } {
  return files.enabled ? { discussion: memoReader((n) => files.read(n)) } : {};
}
