import type { PetState } from '../types.js';
import { PetSprite } from '../components/PetSprite.js';
import { absDate } from '../components/util.js';

/**
 * The enclosure: the foot of the queue rail beside it, the foot of the page in
 * one column.
 *
 * Rendered **last in `.cn-body`**, after the situation area, because document
 * order is the whole arrangement once the shell collapses to one column — inside
 * the rail this drew half way down a narrow page, between the queue and the work.
 * Last, it is the end of the page: scrolled to after the work rather than pinned
 * across the bottom of it. Above 1100px the sheet places it back into the rail's
 * column as its second row, so a queue longer than the rail scrolls behind it
 * rather than pushing it off the bottom. Always in flow: it covers nothing.
 * → docs/spec/22-pets.md#the-vivarium
 *
 * **One button per creature, rather than one over the floor.** The floor used to
 * be a single button because it had a single destination; an egg gives it two, and
 * a click cannot have two destinations. So each animal is its own control — an egg
 * opens its shell, anything else opens the panel — and the bar underneath carries
 * the way in for an empty enclosure. Nested buttons would be the other way to
 * spell this, and they are not a thing HTML has.
 */
export function Vivarium({
  pets,
  runningAgents,
  paused,
  onOpen,
  onHatch,
}: {
  pets: PetState;
  runningAgents: number;
  paused: boolean;
  onOpen: () => void;
  onHatch: (id: string) => void;
}) {
  const placed = pets.pets.filter((pet) => pet.placed);
  // Everything unopened, placed or not. The count is what the badge says, because
  // an egg the enclosure had no room for is still an egg you have not looked in —
  // and it is reachable from the panel the badge's own click opens.
  const eggs = pets.pets.filter((pet) => pet.openedAt === null);
  return (
    <div className="cn-viv">
      <div className="cn-viv-floor">
        {placed.length === 0 ? (
          <button type="button" className="cn-viv-empty" onClick={onOpen}>
            Nothing has hatched yet
          </button>
        ) : (
          placed.map((pet) =>
            pet.openedAt === null ? (
              <button
                key={pet.id}
                type="button"
                className="cn-viv-egg"
                title="An egg. Click to open it."
                onClick={() => onHatch(pet.id)}
              >
                <PetSprite pet={pet} size={sizeFor(pet.stage)} beatMs={beatMs(runningAgents, paused)} />
              </button>
            ) : (
              <button key={pet.id} type="button" className="cn-viv-pet" title="Open the vivarium" onClick={onOpen}>
                <PetSprite pet={pet} size={sizeFor(pet.stage)} beatMs={beatMs(runningAgents, paused)} />
              </button>
            ),
          )
        )}
      </div>
      <button type="button" className="cn-viv-bar" onClick={onOpen}>
        <span>
          Vivarium · {placed.length} of {pets.pets.length}
        </span>
        {/* Said plainly rather than drawn as an alert. An egg is a nice thing
            waiting, and nothing in this subsystem nags: it sits there for as long
            as the operator leaves it, and nothing expires it. */}
        {eggs.length > 0 ? (
          <span className="cn-viv-eggs">
            {eggs.length} egg{eggs.length === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="cn-viv-beats">{pets.wallet.balance.toLocaleString()} beats</span>
      </button>
      {/* Under the bar rather than in it, and not a control: the bar is a button,
          and this is a fact about the deployment with nowhere of its own to go.
          It is here at all because this corner is where "nothing has hatched" is
          read — an enclosure that has stayed empty through a week of work looks
          identical to one on a harness whose whole history sorts before the
          start, and only the date tells them apart. Nothing is drawn before the
          first scan has settled one. */}
      {pets.startedAt === null ? null : (
        <p className="cn-viv-since" title="Actions from before this date are on record and roll nothing.">
          counting since {absDate(pets.startedAt)}
        </p>
      )}
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
