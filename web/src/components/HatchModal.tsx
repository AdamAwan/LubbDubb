import { useEffect, useRef, useState } from 'react';
import type { PetView } from '../types.js';
import { PetSprite } from './PetSprite.js';

/**
 * The shell coming off, over the surface the operator was already looking at.
 *
 * The ceremony is the whole of this file. What it is a ceremony *about* was
 * decided when the scan rolled the action — species, tier and colours all come out
 * of `hash32(kind:ref)` — so nothing here chooses anything, and the modal would
 * draw exactly the same animal if it ran a hundred times.
 * → `docs/spec/22-pets.md#the-egg`
 */

/** Rocks before the shell goes, and the gap between them. */
const ROCKS = 3;
const ROCK_MS = 700;
/** The flash, and how long after it the hatchling is on screen. */
const FLASH_MS = 260;

export function HatchModal({
  pet,
  onOpen,
  onClose,
}: {
  pet: PetView;
  onOpen: (id: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [rocks, setRocks] = useState(0);
  const [phase, setPhase] = useState<'rocking' | 'flash' | 'out'>('rocking');
  // The request is fired once for the whole life of the modal, not once per
  // render and not once per rock: `openPet` is idempotent, but a re-run would
  // still put a write on the socket for every frame React felt like giving us.
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void onOpen(pet.id);
  }, [onOpen, pet.id]);

  useEffect(() => {
    // Reduced motion gets the reveal and none of the shaking. The click still
    // means the same thing and the shell still comes off — what it does not do is
    // rock a creature at somebody who asked the platform for less movement.
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // **The animation decides what is drawn, never the snapshot.** The write above
  // stamps `openedAt` and broadcasts, so the live pet turns into a hatchling on
  // whatever pulse the socket delivers — which is usually somewhere around the
  // second rock. Drawing the prop would pop the shell off mid-wobble on a fast
  // machine and hold it on to the end on a slow one, and the surface would be
  // right both times.
  const out = phase === 'out';
  const shown: PetView = { ...pet, openedAt: out ? (pet.openedAt ?? new Date().toISOString()) : null };

  return (
    <div className="cn-backdrop" onClick={onClose}>
      <div
        className="cn-hatch"
        role="dialog"
        aria-modal="true"
        aria-label={out ? `a ${pet.rarity} hatchling` : 'an egg, hatching'}
        onClick={(event) => event.stopPropagation()}
      >
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
        <button type="button" className="cn-btn" onClick={onClose}>
          {out ? 'Done' : 'Skip'}
        </button>
      </div>
    </div>
  );
}
