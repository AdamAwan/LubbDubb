import type { CalendarEvent, Issue, PullRequest, Story, WorldEventInput, WorldSnapshot } from '../types.js';

/**
 * Derive the observed state transitions between two consecutive world
 * snapshots. Pure and infra-free (no ids, no clock) so it unit-tests directly;
 * the store stamps id + timestamp when it persists the results.
 *
 * Object identity is by domain id. A newly appeared object emits a single
 * `*_opened`/`*_added` — never its per-field transitions on top — because "it's
 * new" already says everything. A removed object emits nothing: a disappearance
 * isn't a progress signal worth a line in the feed.
 */
export function diffWorlds(prev: WorldSnapshot, next: WorldSnapshot): WorldEventInput[] {
  const events: WorldEventInput[] = [];

  const prevPrs = byId(prev.pullRequests);
  for (const pr of next.pullRequests) {
    const before = prevPrs.get(pr.id);
    if (!before) {
      events.push({ kind: 'pr_opened', ref: prRef(pr), summary: `PR #${pr.number} opened: ${pr.title}` });
      continue;
    }
    if (before.ciStatus !== pr.ciStatus) {
      events.push({ kind: 'pr_ci', ref: prRef(pr), summary: `PR #${pr.number} CI ${pr.ciStatus}` });
    }
    if (!before.approved && pr.approved) {
      events.push({ kind: 'pr_approved', ref: prRef(pr), summary: `PR #${pr.number} approved` });
    }
    if (!before.mergeable && pr.mergeable) {
      events.push({ kind: 'pr_mergeable', ref: prRef(pr), summary: `PR #${pr.number} is mergeable` });
    }
    if (!before.merged && pr.merged) {
      events.push({ kind: 'pr_merged', ref: prRef(pr), summary: `PR #${pr.number} merged` });
    }
    const seen = new Set(before.unresolvedComments.map((c) => c.id));
    for (const comment of pr.unresolvedComments) {
      if (!seen.has(comment.id)) {
        events.push({ kind: 'pr_comment', ref: prRef(pr), summary: `PR #${pr.number}: ${comment.author} commented` });
      }
    }
  }

  const prevIssues = byId(prev.issues);
  for (const issue of next.issues) {
    const before = prevIssues.get(issue.id);
    if (!before) {
      events.push({
        kind: 'issue_opened',
        ref: issueRef(issue),
        summary: `Issue #${issue.number} opened: ${issue.title}`,
      });
      continue;
    }
    if (before.state === 'open' && issue.state === 'closed') {
      events.push({ kind: 'issue_closed', ref: issueRef(issue), summary: `Issue #${issue.number} closed` });
    }
    if (before.linkedPrNumber === null && issue.linkedPrNumber !== null) {
      events.push({
        kind: 'issue_linked',
        ref: issueRef(issue),
        summary: `Issue #${issue.number} linked to PR #${issue.linkedPrNumber}`,
      });
    }
  }

  const prevStories = byId(prev.stories);
  for (const story of next.stories) {
    const before = prevStories.get(story.id);
    if (!before) {
      events.push({ kind: 'story_added', ref: storyRef(story), summary: `Story added: ${story.title}` });
      continue;
    }
    if (before.state !== story.state) {
      events.push({ kind: 'story_state', ref: storyRef(story), summary: `Story "${story.title}" → ${story.state}` });
    }
  }

  const prevMeetings = byId(prev.calendar);
  for (const meeting of next.calendar) {
    const before = prevMeetings.get(meeting.id);
    if (!before) {
      events.push({ kind: 'meeting_added', ref: meetingRef(meeting), summary: `Meeting added: ${meeting.title}` });
      continue;
    }
    if (!before.prepDone && meeting.prepDone) {
      events.push({ kind: 'meeting_prep', ref: meetingRef(meeting), summary: `Prep done for "${meeting.title}"` });
    }
  }

  return events;
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

const prRef = (pr: PullRequest): string => `pr:${pr.number}`;
const issueRef = (issue: Issue): string => `issue:${issue.number}`;
const storyRef = (story: Story): string => `story:${story.id}`;
const meetingRef = (meeting: CalendarEvent): string => `meeting:${meeting.id}`;
