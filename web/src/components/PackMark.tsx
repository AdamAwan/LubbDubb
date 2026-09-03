import type { JSX } from 'react';
import type { PrPackStanding } from '../types.js';
import { Icon } from './icons.js';
import { Tip, useTip } from './tip.js';

/**
 * Whether a pull request has a **review pack** — the third mark in the rack's
 * reading slot, beside [the fleet's review](./ReviewMark.tsx) and
 * [the checks](./CiMark.tsx).
 *
 * **A reading, never the control.** Asking for a pack and opening one are the
 * pull request page's `ReviewPackControl`, which reads the document over its own
 * route and can say everything about it; this mark answers the one question a
 * rack can afford to ask of twenty rows at once — *is there something written
 * here worth going to read* — off the standing the snapshot already carries.
 *
 * **Absent draws nothing.** A grey "no pack" glyph on every row of a deployment
 * that has never asked for one is a claim about a feature nobody turned on, which
 * is the same silence the review's mark keeps.
 * → docs/spec/31-review-packs.md#on-the-row
 */

/** The arm's tone, which is the shared family's triple and never a hue written here. */
const TONE: Record<PrPackStanding, string> = {
  current: 't-blue',
  stale: 't-amber',
  unplaced: 't-grey',
  writing: 't-accent',
};

/** What the mark claims, in one line — the tooltip's heading and the accessible name. */
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

/** The sentence under the heading: what the reader gets, or what to expect. */
function packSaidMore(standing: PrPackStanding): string {
  switch (standing) {
    case 'current':
      return 'The change restated as ideas, in a reading order, with each claim checked.';
    case 'stale':
      // Stale is amber and not red on purpose: it is still the only restatement of
      // this change anybody has, and the page it opens says how far behind.
      return 'It is still the best reading anybody has of this change; the page says how far behind it is.';
    case 'unplaced':
      return 'The provider reported this pull request with no head commit, so whether the pack is current cannot be decided here.';
    case 'writing':
      return 'An author is on the pull request now. The pack replaces this mark when it lands.';
  }
}

/**
 * The mark. `writing` is dashed for `deciding`'s reason on the review mark — it is
 * the one state that changes on its own — and the badge says which of the two
 * states that are *about the document* this is, rather than spending a second hue.
 */
export function PackMark({
  pack,
  reserve = false,
  onOpen,
}: {
  pack: PrPackStanding | undefined;
  /**
   * Keep the mark's width where this row has no pack but its neighbours do — the
   * checks chip beside it is what an eye runs down, and a row that closes the slot
   * moves it. Off by default, so a card whose rows never have a pack pays no
   * gutter for one.
   */
  reserve?: boolean;
  onOpen?: () => void;
}): JSX.Element | null {
  const tip = useTip();
  if (pack === undefined) return reserve ? <span className="pk pk-none" aria-hidden="true" /> : null;

  // A button where there is somewhere to go, a span where there is not — never a
  // span with a click handler, which no keyboard reaches.
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
