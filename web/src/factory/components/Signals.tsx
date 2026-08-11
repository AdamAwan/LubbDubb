import type { JSX } from 'react';
import type { WorldEvent } from '../../types.js';
import { linkify, refLink, relTime } from '../../components/util.js';
import { iconForEventKind, signalPolarity, type SignalPolarity } from '../vocabulary.js';
import { Icon } from './Sprite.js';

/**
 * The world's changes as circuit signals.
 *
 * A signal in the game is a wire, an item tile and a count, and that happens to
 * be exactly the shape of a `WorldEvent`: what moved, on what, how many times.
 * The count is the part a flat list was throwing away — three review comments on
 * one PR arrive as three rows that read as three unrelated things.
 */

const WIRE: Record<SignalPolarity, { color: string; d: string }> = {
  up: { color: 'var(--green)', d: 'M0 17 C 12 17 18 4 34 4' },
  down: { color: 'var(--red)', d: 'M0 4 C 12 4 18 17 34 17' },
  neutral: { color: 'var(--grey)', d: 'M0 11 C 12 11 22 11 34 11' },
};

const SIGN: Record<SignalPolarity, string> = { up: '+', down: '−', neutral: '' };

interface SignalRow {
  key: string;
  event: WorldEvent;
  count: number;
}

/**
 * One row per (kind, ref), carrying the newest event's wording and how many
 * arrived. Insertion order is preserved, so the list stays in the order the
 * server sent — newest first — rather than being re-sorted by a count.
 */
function group(events: readonly WorldEvent[]): SignalRow[] {
  const rows = new Map<string, SignalRow>();
  for (const event of events) {
    const key = `${event.kind}|${event.ref ?? ''}`;
    const existing = rows.get(key);
    if (existing) existing.count += 1;
    else rows.set(key, { key, event, count: 1 });
  }
  return [...rows.values()];
}

export function Signals({
  events,
  now,
  refUrls,
}: {
  events: WorldEvent[];
  now: number;
  refUrls: Record<string, string>;
}): JSX.Element {
  if (events.length === 0) {
    return <p className="fx-empty">The world has not moved.</p>;
  }
  const rows = group(events).slice(0, 10);

  return (
    <div className="fx-signals">
      {rows.map(({ key, event, count }) => {
        const polarity = signalPolarity(event.kind);
        const wire = WIRE[polarity];
        return (
          <div key={key} className="fx-signal">
            <svg className="fx-wire" viewBox="0 0 34 22" aria-hidden="true">
              <path d={wire.d} fill="none" stroke={wire.color} strokeWidth="1.6" />
              <circle cx="34" cy={polarity === 'up' ? 4 : polarity === 'down' ? 17 : 11} r="2.6" fill={wire.color} />
            </svg>
            <span className={`fx-sig-tile ${polarity}`}>
              <Icon name={iconForEventKind(event.kind)} className="sm" />
              <span className="cnt">
                {SIGN[polarity]}
                {count}
              </span>
            </span>
            <span className="fx-sig-txt">
              <span className="r">{event.ref ? refLink(event.ref, refUrls) : event.kind}</span>
              <span className="s" title={event.summary}>
                {linkify(event.summary, refUrls)}
              </span>
            </span>
            <span className="fx-ref">{relTime(event.createdAt, now)}</span>
          </div>
        );
      })}
    </div>
  );
}
