import { useEffect, useState } from 'react';
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
 * **A mythic twinkles on the same clock it bobs on.** `beatMs` drives both, so a
 * busy fleet sparkles faster and a paused one holds still — one clock, and no
 * second timer to get out of step with the first. The phase is state here rather
 * than a clock read inside the drawing, which is what keeps the sprite a pure
 * function of what it is handed. → {@link SpeciesSprite}
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
  // An unopened mythic twinkles too. The shell already says the tier — a mythic
  // egg is banded end to end for exactly that reason — so withholding the sparkle
  // would hide nothing and cost the one moment it is most worth having.
  const phase = useTwinkle(pet.rarity === 'mythic' ? beatMs : 0);
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
        phase={phase}
      />
    </span>
  );
}

/**
 * The sparkle's beat, or a held 0.
 *
 * Zero means still, exactly as it does for the bob — passed for anything that is
 * not a hatched mythic, so the interval below is never even created for the
 * twenty species that have nothing to twinkle. `prefers-reduced-motion` holds it
 * at the same fixed phase the server-rendered nothing would have, which leaves
 * the glow and one or two sparks lit rather than removing the tier's device
 * along with its motion.
 */
function useTwinkle(beatMs: number): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (beatMs <= 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Four steps to a beat: the bob's period is a heartbeat, and a sparkle that
    // changed only once per heartbeat reads as a redraw rather than as light.
    const timer = window.setInterval(() => setPhase((current) => (current + 1) % 8), Math.max(160, beatMs / 4));
    return () => window.clearInterval(timer);
  }, [beatMs]);
  return phase;
}
