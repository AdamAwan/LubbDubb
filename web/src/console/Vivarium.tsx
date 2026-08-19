import type { PetState } from '../types.js';
import { PetSprite } from '../components/PetSprite.js';

/**
 * The enclosure at the foot of the queue rail.
 *
 * Rendered **below** `.cn-rail-list`, which is already a flex column with a
 * scrolling list — so this is a pinned footer: a queue longer than the rail
 * scrolls behind it rather than pushing it off the bottom. Always in frame, and
 * it covers nothing.
 *
 * The whole surface is one button, because the whole surface has one
 * destination. A reference inside a button would be two destinations for one
 * click, which is the cockpit's rule about where a ref may go.
 */
export function Vivarium({
  pets,
  runningAgents,
  paused,
  onOpen,
}: {
  pets: PetState;
  runningAgents: number;
  paused: boolean;
  onOpen: () => void;
}) {
  const placed = pets.pets.filter((pet) => pet.placed);
  return (
    <div className="cn-viv">
      <button type="button" className="cn-viv-floor" onClick={onOpen} title="Open the vivarium">
        {placed.length === 0 ? (
          <span className="cn-viv-empty">Nothing has hatched yet</span>
        ) : (
          placed.map((pet) => (
            <PetSprite key={pet.id} pet={pet} size={sizeFor(pet.stage)} beatMs={beatMs(runningAgents, paused)} />
          ))
        )}
      </button>
      <div className="cn-viv-bar">
        <span>
          Vivarium · {placed.length} of {pets.pets.length}
        </span>
        <span className="cn-viv-beats">{pets.wallet.balance.toLocaleString()} beats</span>
      </div>
    </div>
  );
}

/** A grown pet is a bigger pet, which is the whole of what growing is for. */
function sizeFor(stage: PetState['pets'][number]['stage']): number {
  return stage === 'adult' ? 42 : stage === 'juvenile' ? 34 : 26;
}

/**
 * How fast the enclosure breathes: quicker with more agents out, still while
 * dispatch is paused.
 *
 * Clamped to a range a heart could plausibly beat at rather than derived from
 * `heartbeatIntervalMs` directly — the default pulse is five minutes, and a bob
 * with a five-minute period is a still image that redraws twice an hour.
 */
function beatMs(runningAgents: number, paused: boolean): number {
  if (paused) return 0;
  return Math.max(1100, 2600 - runningAgents * 400);
}
