import { useEffect, useRef, useState } from 'react';
import type { PetView } from '../types.js';
import { Modal } from './Modal.js';
import { PetSprite } from './PetSprite.js';
import { Button } from './button.js';

// → docs/spec/17-cockpit.md

const ROCKS = 3;
const ROCK_MS = 700;
const FLASH_MS = 260;

export function HatchModal({
  petId,
  pets,
  onOpen,
  onClose,
}: {
  petId: string;
  pets: readonly PetView[];
  onOpen: (id: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [rocks, setRocks] = useState(0);
  const [phase, setPhase] = useState<'rocking' | 'flash' | 'out'>('rocking');
  const asked = useRef(false);
  const held = useRef<PetView | null>(null);
  const live = pets.find((p) => p.id === petId) ?? null;
  if (live !== null) held.current = live;
  const pet = held.current;

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void onOpen(petId);
  }, [onOpen, petId]);

  useEffect(() => {
    const still =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (still) {
      setRocks(ROCKS);
      setPhase('out');
      return;
    }
    const timers = [
      ...Array.from({ length: ROCKS }, (_, i) => setTimeout(() => setRocks(i + 1), i * ROCK_MS)),
      setTimeout(() => setPhase('flash'), ROCKS * ROCK_MS),
      setTimeout(() => setPhase('out'), ROCKS * ROCK_MS + FLASH_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  const out = phase === 'out';
  if (pet === null) return null;
  const shown: PetView = { ...pet, openedAt: out ? (pet.openedAt ?? new Date().toISOString()) : null };

  return (
    <Modal face="hatch" label={out ? `a ${pet.rarity} hatchling` : 'an egg, hatching'} onClose={onClose}>
      <div className={`cn-hatch-floor${phase === 'flash' ? ' is-flash' : ''}`}>
        {/* Keyed on the rock count so each one restarts the animation: a class
              re-applied to the same element does not replay it, which is the bug
              where the egg lurches once and then sits there cracking silently. */}
        <span key={`${phase}-${rocks}`} className={out ? 'cn-hatch-pet is-out' : 'cn-hatch-pet is-rocking'}>
          <PetSprite pet={shown} size={out ? 128 : 112} beatMs={0} rocks={rocks} />
        </span>
      </div>
      <div className="cn-hatch-say" aria-live="polite">
        {out ? (
          <>
            <b>
              A {pet.rarity} {shown.stage}.
            </b>
            <p>
              {/* The tier, and not the species: one hatchling grid serves every
                    animal of a tier, and which one it is arrives at the juvenile
                    stage. The wait is the point — see the spec. */}
              Feed it to find out what it is.
            </p>
          </>
        ) : (
          <>
            <b>Something is moving.</b>
            <p>&nbsp;</p>
          </>
        )}
      </div>
      <Button onClick={onClose}>{out ? 'Done' : 'Skip'}</Button>
    </Modal>
  );
}
