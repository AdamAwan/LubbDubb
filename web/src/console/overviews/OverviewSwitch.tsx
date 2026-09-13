import type { JSX } from 'react';
import type { CockpitActions } from '../../cockpit/actions.js';
import type { OverviewShape } from '../../cockpit/place.js';
import { OVERVIEW_SHAPES } from '../../cockpit/place.js';

// → docs/spec/17-cockpit.md#the-overview

const SHAPE_LABEL: Record<OverviewShape, string> = {
  cards: 'Cards',
  next: 'Next',
};

const SHAPE_TITLE: Record<OverviewShape, string> = {
  cards: "Today's overview — fleet, goals in flight, pull requests",
  next: 'The single ask holding the most work, and nothing else',
};

/**
 * Which of the four overview shapes is drawn. The shape is a
 * [place](../../cockpit/place.ts), so a link to one is a link somebody can send.
 */
export function OverviewSwitch({ shape, actions }: { shape: OverviewShape; actions: CockpitActions }): JSX.Element {
  return (
    <div className="cn-ov-switch" role="tablist" aria-label="Overview shape">
      <span className="cn-ov-switch-label">Overview</span>
      {OVERVIEW_SHAPES.map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={s === shape}
          className={s === shape ? 'cn-ov-switch-on' : ''}
          title={SHAPE_TITLE[s]}
          onClick={() => actions.setOverviewShape(s)}
        >
          {SHAPE_LABEL[s]}
        </button>
      ))}
    </div>
  );
}
