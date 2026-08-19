import type { PetView } from '../types.js';
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
 */
export function PetSprite({ pet, size, beatMs }: { pet: PetView; size: number; beatMs: number }) {
  return (
    <span
      className={beatMs > 0 ? 'pet-sprite is-beating' : 'pet-sprite'}
      style={beatMs > 0 ? { animationDuration: `${beatMs}ms` } : undefined}
      title={`${pet.name ?? pet.display} · ${pet.stage}`}
    >
      <SpeciesSprite species={pet.species} rarity={pet.rarity} stage={pet.stage} seed={pet.seed} size={size} />
    </span>
  );
}
