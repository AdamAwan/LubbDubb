import { useEffect, useRef, useState } from 'react';
import type { PetView } from '../types.js';
import { Modal } from './Modal.js';
import { PetSprite } from './PetSprite.js';
import { Button } from './button.js';

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
  petId,
  pets,
  onOpen,
  onClose,
}: {
  petId: string;
  /** The live collection. The modal finds its own pet in it — see below. */
  pets: readonly PetView[];
  onOpen: (id: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [rocks, setRocks] = useState(0);
  const [phase, setPhase] = useState<'rocking' | 'flash' | 'out'>('rocking');
  // The request is fired once for the whole life of the modal, not once per
  // render and not once per rock: `openPet` is idempotent, but a re-run would
  // still put a write on the socket for every frame React felt like giving us.
  const asked = useRef(false);
  // The first pet this modal ever matched, kept for as long as it is open.
  //
  // The lookup lives here rather than at the call site because a caller that
  // renders `pet !== null && <HatchModal/>` unmounts the whole ceremony the
  // instant a snapshot arrives without this row in it — a reconnect, a refetch
  // mid-write — and a remount restarts the sequence from the first rock. The
  // symptom is an egg that wobbles twice as long as it should, on exactly the
  // machines where the socket is slowest, and nothing about it is red.
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

  // **The animation decides what is drawn, never the snapshot.** The write above
  // stamps `openedAt` and broadcasts, so the live pet turns into a hatchling on
  // whatever pulse the socket delivers — which is usually somewhere around the
  // second rock. Drawing the prop would pop the shell off mid-wobble on a fast
  // machine and hold it on to the end on a slow one, and the surface would be
  // right both times.
  const out = phase === 'out';
  // A `?hatch=` naming nothing — a stale link, a pet that has since been blended —
  // draws nothing rather than an empty modal. After the hooks, so the ceremony's
  // own clock is never conditional on the snapshot.
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
