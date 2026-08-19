import type { PetView } from '../types.js';
import { petLabel } from '../pets/reveal.js';
import { SpeciesSprite } from './SpeciesSprite.js';

/**
 * One pet of the collection, drawn and bobbing.
 *
 * The drawing itself is {@link SpeciesSprite}; what this adds is the two things
 * that only make sense for a pet somebody owns — the idle bob, and the name it
 * answers to on hover.
 *
 * `beatMs` is the period of that bob, and **zero means still**. The caller derives
 * it from how busy the fleet is, which is what makes the corner of the rail worth
 * putting a creature in at all: a vivarium that quickens under load and sleeps
 * while dispatch is paused is a fleet status you can read from across the room
 * without parsing anything.
 *
 * The bob is CSS on the wrapper rather than a redraw, so however many pets are on
 * screen they animate on one clock and cost one composite.
 *
 * **An unopened pet draws as its shell**, and `rocks` is how far through the hatch
 * it is. The form is what decides the grid, so the species goes down to the canvas
 * exactly as it does for a hatchling — and is ignored there just the same, which is
 * what keeps the reveal honest rather than merely unrendered. The name on hover
 * goes through `petLabel` for the same reason.
 */
export function PetSprite({
  pet,
  size,
  beatMs,
  rocks = 0,
}: {
  pet: PetView;
  size: number;
  beatMs: number;
  rocks?: number;
}) {
  return (
    <span
      className={beatMs > 0 ? 'pet-sprite is-beating' : 'pet-sprite'}
      style={beatMs > 0 ? { animationDuration: `${beatMs}ms` } : undefined}
      title={petLabel(pet)}
    >
      <SpeciesSprite
        species={pet.species}
        rarity={pet.rarity}
        stage={pet.openedAt === null ? 'egg' : pet.stage}
        seed={pet.seed}
        size={size}
        rocks={rocks}
      />
    </span>
  );
}
