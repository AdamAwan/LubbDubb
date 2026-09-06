import type { PetState } from '../types.js';
import { PetSprite } from '../components/PetSprite.js';
import { absDate } from '../components/util.js';

// → docs/spec/17-cockpit.md

export function Vivarium({
  pets,
  runningAgents,
  paused,
  onOpen,
  onOpenPage,
  onHatch,
}: {
  pets: PetState;
  runningAgents: number;
  paused: boolean;
  onOpen: () => void;
  onOpenPage: () => void;
  onHatch: (id: string) => void;
}) {
  const placed = pets.pets.filter((pet) => pet.placed);
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
      <button
        type="button"
        className="cn-viv-bar"
        onClick={onOpenPage}
        title="Pets — what the vivarium is and how it fills"
      >
        {/* **"Pets", not "Vivarium".** The strip is the nav's old tab now, and it
            has to answer the question the tab answered — a caption naming the
            enclosure told an operator what they were looking at, which is the one
            thing the corner already says for itself. The counts follow it, so the
            word reads as the destination and the numbers as what is at it. */}
        <span className="cn-viv-name">Pets</span>
        <span>
          {placed.length} of {pets.pets.length}
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
        <i className="cn-viv-chev">›</i>
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

function sizeFor(stage: PetState['pets'][number]['stage']): number {
  return stage === 'adult' ? 42 : stage === 'juvenile' ? 34 : 26;
}

function beatMs(runningAgents: number, paused: boolean): number {
  if (paused) return 0;
  return Math.max(1100, 2600 - runningAgents * 400);
}
