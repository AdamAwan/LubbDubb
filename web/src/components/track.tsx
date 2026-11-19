import type { JSX } from 'react';
import type { GoalTrack } from '../view/goalPage.js';
import { plural } from '../view/plural.js';

// → docs/spec/17-cockpit.md#grouped-by-goal-stacks-as-a-tree

export function Track({ track }: { track: GoalTrack }): JSX.Element {
  const segs = [
    ...Array<string>(track.merged).fill('cn-done'),
    ...Array<string>(track.now).fill('cn-live'),
    ...Array<string>(track.held).fill('cn-block'),
    ...Array<string>(track.waiting).fill(''),
  ];
  return (
    <span className="cn-track" title={trackTitle(track)}>
      {segs.map((tone, i) => (
        <i className={`cn-seg ${tone}`} key={i} />
      ))}
    </span>
  );
}

function trackTitle(track: GoalTrack): string {
  const parts = [
    track.merged > 0 ? `${track.merged} merged` : '',
    track.now > 0 ? `${track.now} in progress` : '',
    track.held > 0 ? `${track.held} blocked` : '',
    track.waiting > 0 ? `${track.waiting} not started` : '',
  ].filter((part) => part !== '');
  return `${plural(track.total, 'part')} — ${parts.join(', ')}`;
}
