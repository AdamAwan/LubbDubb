import type { PetRarity, PetSpecies, PetStage } from '../types.js';

/**
 * The pixel grids, and the only place in the codebase that knows what a species
 * looks like.
 *
 * The wire carries `species`, `stage` and `seed`; what those *draw as* is a
 * cockpit fact, and a server that also knew would be a second place to change the
 * day a sprite changes.
 *
 * One exported const per group rather than one per creature, because knip runs
 * every rule at `error` and nine separately-exported grids would read as nine
 * unimported symbols.
 *
 * Characters, uniform across every grid:
 *   `.` nothing   `o` outline   `O` body   `h` highlight   `e` eye   `m` marking
 *
 * Rows are padded to the widest at draw time, so a grid that is ragged in the
 * source is still square on the canvas — the alternative is counting dots.
 */

/**
 * Every species in a rarity tier shares one hatchling.
 *
 * This began as an art saving — four grids instead of nine — and turned out to be
 * the better mechanic: a hatchling is a thing you are *waiting to find out about*,
 * and the reveal at the juvenile stage is worth more than the five sprites it
 * costs. The tier still shows through, so a mythic egg is recognisably a prize
 * before it is anything else.
 */
const HATCHLINGS: Record<PetRarity, readonly string[]> = {
  common: ['..oooo..', '.oOOOOo.', 'oOhOOhOo', 'oOeOOeOo', 'oOOOOOOo', 'oOOmmOOo', '.oOOOOo.', '..oooo..'],
  uncommon: ['..o..o..', '..oooo..', '.oOhhOo.', 'oOOOOOOo', 'oOeOOeOo', 'oOOOOOOo', '.oOmmOo.', '..oooo..'],
  rare: ['...oo...', '..oOOo..', '.oOhhOo.', 'oOOOOOOo', 'oOeOOeOo', 'oOmOOmOo', '.oOOOOo.', '..oooo..'],
  mythic: ['.o.oo.o.', '.oooooo.', 'oOhOOhOo', 'oOOOOOOo', 'oOeOOeOo', 'oOmmmmOo', 'oOOOOOOo', '.oooooo.'],
};

/** The juvenile is the first form that says what you have. */
const JUVENILES: Record<PetSpecies, readonly string[]> = {
  pip: [
    '...ooooo...',
    '..oOOOOOo..',
    '.oOhOOOhOo.',
    'oOOeOOOeOOo',
    'oOOOOOOOOOo',
    'oOOOmmmOOOo',
    '.oOOOOOOOo.',
    '..oOOOOOo..',
    '...ooooo...',
    '...o...o...',
    '...o...o...',
  ],
  nib: [
    '.....o.....',
    '....ooo....',
    '...oOOOo...',
    '..oOhOhOo..',
    '.oOOeOeOOo.',
    'oOOOOOOOOOo',
    'oOOOmmmOOOo',
    '.oOOOOOOOo.',
    '..oOOOOOo..',
    '...ooooo...',
    '...o...o...',
  ],
  tuft: [
    '..o.....o..',
    '.oOo...oOo.',
    '.oOOoooOOo.',
    'oOhOOOOOhOo',
    'oOeOOOOOeOo',
    'oOOOOOOOOOo',
    'oOOmmmmmOOo',
    '.oOOOOOOOo.',
    '..oOOOOOo..',
    '...ooooo...',
    '..o.....o..',
  ],
  warden: [
    '..oo...oo..',
    '.oOOo.oOOo.',
    '.oOOOoOOOo.',
    'oOhOOOOOhOo',
    'oOeOOOOOeOo',
    'oOOOmmmOOOo',
    'oOOOOOOOOOo',
    'oOOOOOOOOOo',
    '.oOOOOOOOo.',
    '..ooooooo..',
    '..o.....o..',
  ],
  cinder: [
    '....o.o....',
    '...oOoOo...',
    '..oOOOOOo..',
    '.oOhOOOhOo.',
    'oOOeOOOeOOo',
    'oOOOOOOOOOo',
    'oOmmOmOmmOo',
    '.oOOOOOOOo.',
    '..oOOOOOo..',
    '...ooooo...',
    '...o...o...',
  ],
  nocturne: [
    '..o.....o..',
    '..oo...oo..',
    '.moOooooOm.',
    'oOOOOOOOOOo',
    'oOeeOOOeeOo',
    'oOeeOOOeeOo',
    'oOOOOOOOOOo',
    '.oOmOOOmOo.',
    '..oOOOOOo..',
    '...ooooo...',
    '..o.....o..',
  ],
  lander: [
    '..ooooooo..',
    '.oOOOOOOOo.',
    'oOhOOOOOhOo',
    'oOeOOOOOeOo',
    'oOOOOOOOOOo',
    'oOmmmmmmmOo',
    'oOOOOOOOOOo',
    'oOOOOOOOOOo',
    '.oOOOOOOOo.',
    '.ooooooooo.',
    '.o.o...o.o.',
  ],
  quill: [
    '....mmm....',
    '...ommmo...',
    '..oOmmmOo..',
    '.oOhOOOhOo.',
    'oOOeOOOeOOo',
    'oOOOOOOOOOo',
    'oOOOmmmOOOo',
    '.oOOOOOOOo.',
    '..oOOOOOo..',
    '...ooooo...',
    '...o...o...',
  ],
  ouroboros: [
    '...ooooo...',
    '..oOOOOOo..',
    '.oOmmmmmOo.',
    'oOmOOOOOmOo',
    'oOmOeOeOmOo',
    'oOmOOOOOmOo',
    'oOmmmOmmmOo',
    '.oOOOOOOOo.',
    '..oOOOOOo..',
    '...ooooo...',
    '..o..o..o..',
  ],
};

/** The adult: the same animal, bigger, with whatever it grew. */
const ADULTS: Record<PetSpecies, readonly string[]> = {
  pip: [
    '....oooooo....',
    '..ooOOOOOOoo..',
    '.oOOOOOOOOOOo.',
    'oOOhOOOOOOhOOo',
    'oOOeOOOOOOeOOo',
    'oOOOOOOOOOOOOo',
    'oOOOOmmmmOOOOo',
    'oOOOOOOOOOOOOo',
    '.oOOOOOOOOOOo.',
    '..oOOOOOOOOo..',
    '...oooooooo...',
    '...o......o...',
    '...o......o...',
    '..oo......oo..',
  ],
  nib: [
    '......oo......',
    '.....oOOo.....',
    '....oOOOOo....',
    '...oOhOOhOo...',
    '..oOOeOOeOOo..',
    '.oOOOOOOOOOOo.',
    'oOOOOmmmmOOOOo',
    'oOOOOOOOOOOOOo',
    'oOOOOOOOOOOOOo',
    '.oOOOOOOOOOOo.',
    '..oOOOOOOOOo..',
    '...oooooooo...',
    '...o......o...',
    '..oo......oo..',
  ],
  tuft: [
    '..oo......oo..',
    '.oOOo....oOOo.',
    '.oOOOooooOOOo.',
    'oOOhOOOOOOhOOo',
    'oOOeOOOOOOeOOo',
    'oOOOOOOOOOOOOo',
    'oOmmmmmmmmmmOo',
    'oOOmmmmmmmmOOo',
    '.oOOOOOOOOOOo.',
    '..oOOOOOOOOo..',
    '...oooooooo...',
    '..o..o..o..o..',
    '..o..o..o..o..',
    '..oo.oo.oo.oo.',
  ],
  warden: [
    '..ooo....ooo..',
    '.oOOOo..oOOOo.',
    '.oOOOOooOOOOo.',
    'oOOOOOOOOOOOOo',
    'oOOhOOOOOOhOOo',
    'oOOeOOOOOOeOOo',
    'oOOOOmmmmOOOOo',
    'oOOOOOOOOOOOOo',
    'oOOOOOOOOOOOOo',
    'oOOOOOOOOOOOOo',
    '.oOOOOOOOOOOo.',
    '..oooooooooo..',
    '..o........o..',
    '.oo........oo.',
  ],
  cinder: [
    '.....o..o.....',
    '....oOooOo....',
    '...oOOOOOOo...',
    '..oOOOOOOOOo..',
    '.oOhOOOOOOhOo.',
    'oOOeOOOOOOeOOo',
    'oOOOOOOOOOOOOo',
    'oOmmOOmmOOmmOo',
    'oOOmmOmmOmmOOo',
    '.oOOOOOOOOOOo.',
    '..oOOOOOOOOo..',
    '...oooooooo...',
    '...o......o...',
    '..oo......oo..',
  ],
  nocturne: [
    '..oo......oo..',
    '.oOOo....oOOo.',
    'moOOOooooOOOom',
    'oOOOOOOOOOOOOo',
    'oOeeOOOOOOeeOo',
    'oOeeOOOOOOeeOo',
    'oOOOOOOOOOOOOo',
    'oOOmOOmmOOmOOo',
    'oOOOmmOOmmOOOo',
    '.oOOOOOOOOOOo.',
    '..oOOOOOOOOo..',
    '...oooooooo...',
    '..o........o..',
    '.oo........oo.',
  ],
  lander: [
    '.oooooooooooo.',
    'oOOOOOOOOOOOOo',
    'oOhOOOOOOOOhOo',
    'oOeOOOOOOOOeOo',
    'oOOOOOOOOOOOOo',
    'oOmmmmmmmmmmOo',
    'oOOOOOOOOOOOOo',
    'oOmmmmmmmmmmOo',
    'oOOOOOOOOOOOOo',
    'oOOOOOOOOOOOOo',
    '.oOOOOOOOOOOo.',
    '.oooooooooooo.',
    '.o.oo....oo.o.',
    '.oo.o....o.oo.',
  ],
  quill: [
    '.....mmmm.....',
    '....mmmmmm....',
    '...ommmmmmo...',
    '..oOmmmmmmOo..',
    '.oOhOmmmmOhOo.',
    'oOOeOOOOOOeOOo',
    'oOOOOOOOOOOOOo',
    'oOOOOmmmmOOOOo',
    'oOOOOOOOOOOOOo',
    '.oOOOOOOOOOOo.',
    '..oOOOOOOOOo..',
    '...oooooooo...',
    '...o......o...',
    '..oo......oo..',
  ],
  ouroboros: [
    '...oooooooo...',
    '..oOOOOOOOOo..',
    '.oOmmmmmmmmOo.',
    'oOmmOOOOOOmmOo',
    'oOmOOOOOOOOmOo',
    'oOmOOeOOeOOmOo',
    'oOmOOOOOOOOmOo',
    'oOmmOOmmOOmmOo',
    'oOOmmmmmmmmOOo',
    '.oOOOOOOOOOOo.',
    '..oOOOOOOOOo..',
    '...oooooooo...',
    '..o..o..o..o..',
    '..oo.oo.oo.oo.',
  ],
};

/** The grid for one pet, at its stage. */
export function spriteFor(species: PetSpecies, rarity: PetRarity, stage: PetStage): readonly string[] {
  if (stage === 'hatchling') return HATCHLINGS[rarity]!;
  return stage === 'juvenile' ? JUVENILES[species]! : ADULTS[species]!;
}
