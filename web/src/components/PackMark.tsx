import type { JSX } from 'react';
import type { PrPackStanding } from '../types.js';
import { Icon } from './icons.js';
import { Tip, useTip } from './tip.js';

// → docs/spec/17-cockpit.md

const TONE: Record<PrPackStanding, string> = {
  current: 't-blue',
  stale: 't-amber',
  unplaced: 't-grey',
  writing: 't-accent',
};

function packSaid(standing: PrPackStanding): string {
  switch (standing) {
    case 'current':
      return 'A review pack, written for this head';
    case 'stale':
      return 'A review pack, written for an older head';
    case 'unplaced':
      return 'A review pack — and no head to place it against';
    case 'writing':
      return 'A review pack is being written';
  }
}

function packSaidMore(standing: PrPackStanding): string {
  switch (standing) {
    case 'current':
      return 'The change restated as ideas, in a reading order, with each claim checked.';
    case 'stale':
      return 'It is still the best reading anybody has of this change; the page says how far behind it is.';
    case 'unplaced':
      return 'The provider reported this pull request with no head commit, so whether the pack is current cannot be decided here.';
    case 'writing':
      return 'An author is on the pull request now. The pack replaces this mark when it lands.';
  }
}

export function PackMark({
  pack,
  reserve = false,
  onOpen,
}: {
  pack: PrPackStanding | undefined;
  reserve?: boolean;
  onOpen?: () => void;
}): JSX.Element | null {
  const tip = useTip();
  if (pack === undefined) return reserve ? <span className="pk pk-none" aria-hidden="true" /> : null;

  const Tag = onOpen === undefined ? 'span' : 'button';
  return (
    <Tag
      ref={tip.anchor as never}
      className={`pk pk-${pack} ${TONE[pack]}${onOpen === undefined ? '' : ' pk-open'}`}
      {...(onOpen === undefined ? { tabIndex: 0, role: 'img' as const } : { type: 'button' as const, onClick: onOpen })}
      aria-label={`Review pack: ${packSaid(pack)}${onOpen === undefined ? '' : ' — open the pull request'}`}
      onMouseEnter={tip.open}
      onFocus={tip.open}
      onMouseLeave={tip.close}
      onBlur={tip.close}
    >
      <Icon name="pack" size={14} />
      {pack === 'stale' && <span className="pk-badge">↺</span>}
      {tip.at !== null && (
        <Tip at={tip.at}>
          <b>{packSaid(pack)}</b>
          <span>{packSaidMore(pack)}</span>
          {onOpen !== undefined && <span className="pk-foot">click for the pull request, where the pack is read</span>}
        </Tip>
      )}
    </Tag>
  );
}
