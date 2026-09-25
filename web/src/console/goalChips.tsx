import type { JSX } from 'react';
import type { Issue, OpenPullRequest } from '../types.js';
import { Tag, type TagTone } from '../components/tag.js';
import { relTime, waitedFor } from '../components/util.js';
import { stateColour } from '../stateColour.js';

// → docs/spec/17-cockpit.md

export function StateChip({
  state,
  colours,
}: {
  state: string;
  colours: Readonly<Record<string, string>>;
}): JSX.Element {
  const colour = stateColour(colours, state);
  return (
    <span className="tag" style={colour === null ? undefined : { color: colour, borderColor: colour }}>
      {state}
    </span>
  );
}

const COURT_TONE: Record<string, TagTone> = {
  you: 'red',
  harness: 'blue',
  stalled: 'amber',
  done: 'green',
};

function courtTone(pr: OpenPullRequest): TagTone | undefined {
  return COURT_TONE[pr.attention.status];
}

/**
 * The tracker has stopped returning this goal, and this is the one place that
 * says so (`wire.Issue.stale`). Drawn on a retained run wherever the goal is
 * listed or opened, and never on a live issue — the field is absent there.
 *
 * Two readings, and it draws whichever the deployment can give. With a ticket
 * mirror, the tracker's own word — `Resolved`, `Closed`, or open with the watch
 * tag gone — because that is the operator's actual question: not "is this stale"
 * but "what happened to it". Without one, only that the item left and when the
 * harness last saw it. The title spells out what the marking covers and what it
 * does not: the tracker's fields are the harness's copy, everything else on the
 * goal is the harness's own record and current.
 *
 * @public drawn on the overview's goal rows as well as the page header
 */
export function StaleChip({ stale, now }: { stale: NonNullable<Issue['stale']>; now: number }): JSX.Element {
  const seen = relTime(stale.lastSeenAt, now);
  const kept = "Its plan, pull requests, agents, spend and notes are the harness's own record and are current.";
  if (stale.tracker === null)
    return (
      <Tag
        dashed
        title={`The tracker no longer returns this item — closed, resolved, or its watch tag removed. The title, description, labels and state shown are the harness's copy from ${seen}. ${kept}`}
      >
        left tracker · seen {seen}
      </Tag>
    );
  const word = stale.tracker.workItemState ?? stale.tracker.state;
  return (
    <Tag
      dashed
      title={`The tracker stopped returning this item and now says ${word} (changed ${relTime(stale.tracker.changedAt, now)}). The title, description and labels shown are the harness's copy from ${seen}. ${kept}`}
    >
      tracker: {word} · seen {seen}
    </Tag>
  );
}

export function CourtChip({ pr, now }: { pr: OpenPullRequest; now: number }): JSX.Element {
  const since = pr.attention.reviewWaitingSince;
  const waited = since !== undefined ? waitedFor(since, now) : null;
  return (
    <Tag
      tone={courtTone(pr)}
      fill={courtTone(pr) !== undefined}
      title={
        waited
          ? [...pr.attention.reasons, `waiting since ${new Date(since!).toLocaleString()}`].join(' · ')
          : pr.attention.reasons.join(' · ')
      }
    >
      {pr.attention.status}
      {waited && <span className="cn-chip-age"> · {waited}</span>}
    </Tag>
  );
}
