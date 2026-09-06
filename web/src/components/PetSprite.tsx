import { useEffect, useState } from 'react';
import type { PetView } from '../types.js';
import { petLabel } from '../pets/reveal.js';
import { SpeciesSprite } from './SpeciesSprite.js';

// → docs/spec/17-cockpit.md

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

function useTwinkle(beatMs: number): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (beatMs <= 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setPhase((current) => (current + 1) % 8), Math.max(160, beatMs / 4));
    return () => window.clearInterval(timer);
  }, [beatMs]);
  return phase;
}
