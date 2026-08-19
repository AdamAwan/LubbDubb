import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dressSprite, SPRITE_PAD, spriteFor } from '../web/src/pets/sprites.js';
import { inkFor, paletteFor } from '../web/src/pets/palette.js';
import { SPECIES } from '../src/pets/catalogue.js';
import type { PetRarity, PetSpecies, PetStage } from '../src/wire.js';

/**
 * The rarity ladder, and the passes under it.
 *
 * These are properties of the *dressing*, not of the drawings: what a creature
 * looks like is a judgement, but that every character it emits has a colour, that
 * the ladder never runs downhill, and that a sparkle drawn twice at one phase is
 * the same sparkle are all things a change can quietly break with nothing red.
 * → `docs/spec/22-pets.md#the-rarity-ladder`
 */

const STAGES: readonly (PetStage | 'egg')[] = ['egg', 'hatchling', 'juvenile', 'adult'];
const EVERY_SPECIES = Object.keys(SPECIES) as PetSpecies[];
const rarityOf = (species: PetSpecies): PetRarity => SPECIES[species].rarity;

/** Every form the cockpit can draw, dressed as it would be drawn. */
function everyForm(phase = 0): { species: PetSpecies; stage: PetStage | 'egg'; grid: readonly string[] }[] {
  return EVERY_SPECIES.flatMap((species) =>
    STAGES.map((stage) => ({
      species,
      stage,
      grid: dressSprite(spriteFor(species, rarityOf(species), stage), rarityOf(species), `seed:${species}`, phase),
    })),
  );
}

test('every character a dressed grid emits has an ink', () => {
  const ink = inkFor(paletteFor('escalation:esc_9f2a'));
  for (let phase = 0; phase < 8; phase++) {
    for (const { species, stage, grid } of everyForm(phase)) {
      for (const row of grid) {
        for (const cell of row) {
          if (cell === '.') continue;
          assert.ok(
            ink[cell] !== undefined,
            `${species}/${stage} emits ${JSON.stringify(cell)}, which the draw loop has no colour for`,
          );
        }
      }
    }
  }
});

test('dressing pads by exactly SPRITE_PAD on every side, at every tier', () => {
  for (const species of EVERY_SPECIES) {
    for (const stage of STAGES) {
      const plain = spriteFor(species, rarityOf(species), stage);
      const grid = dressSprite(plain, rarityOf(species), 'seed', 0);
      const plainWidth = Math.max(...plain.map((row) => row.length));
      assert.equal(grid.length, plain.length + SPRITE_PAD * 2, `${species}/${stage} height`);
      for (const row of grid) assert.equal(row.length, plainWidth + SPRITE_PAD * 2, `${species}/${stage} width`);
    }
  }
});

test('a rare glints and a common does not, on the same grid', () => {
  const plain = spriteFor('pip', 'common', 'adult');
  const asCommon = dressSprite(plain, 'common', 'seed', 0).join('');
  const asRare = dressSprite(plain, 'rare', 'seed', 0).join('');
  assert.equal(asCommon.includes('s'), false, 'a common drew a rare glint');
  assert.equal([...asRare].filter((cell) => cell === 's').length, 4, 'a rare should carry four glints');
});

test('the ladder never runs downhill: a tier draws nothing the tier above lacks', () => {
  const outside = (grid: readonly string[]): Set<string> =>
    new Set([...grid.join('')].filter((cell) => 'gsAa'.includes(cell)));
  const plain = spriteFor('pip', 'common', 'adult');
  const tiers: PetRarity[] = ['common', 'uncommon', 'rare', 'mythic'];
  const devices = tiers.map((rarity) => outside(dressSprite(plain, rarity, 'seed', 1)));
  assert.deepEqual([...devices[0]!], [], 'a common should draw nothing outside its outline');
  assert.deepEqual([...devices[1]!], [], 'an uncommon should draw nothing outside its outline');
  assert.ok(devices[2]!.size > 0, 'a rare should draw something outside its outline');
  assert.ok(devices[3]!.size > devices[2]!.size, 'a mythic should out-dress a rare');
});

test('a mythic sparkles at every phase, and never with all four sparks at once', () => {
  for (const species of EVERY_SPECIES.filter((key) => rarityOf(key) === 'mythic')) {
    const seed = `upgrade:${species}`;
    const counts = Array.from({ length: 8 }, (_, phase) => {
      const grid = dressSprite(spriteFor(species, 'mythic', 'adult'), 'mythic', seed, phase);
      return [...grid.join('')].filter((cell) => cell === 'A').length;
    });
    for (const [phase, count] of counts.entries()) {
      assert.ok(count > 0, `${species} went dark at phase ${phase}`);
      assert.ok(count < 4, `${species} lit every spark at once at phase ${phase}`);
    }
    assert.ok(new Set(counts).size > 1, `${species} never changes, so nothing twinkles`);
  }
});

test('the sparkle is a function of its phase, not of when it was drawn', () => {
  const draw = (phase: number): string =>
    dressSprite(spriteFor('ouroboros', 'mythic', 'adult'), 'mythic', 'upgrade:up_318', phase).join('\n');
  assert.equal(draw(3), draw(3), 'the same phase drew two different sprites');
  assert.notEqual(draw(3), draw(5), 'two phases drew the same sprite');
  // The cycle is what a caller's modulo relies on: phase 8 is phase 0 again.
  assert.equal(draw(0), draw(8));
});

test('two mythics of one species sparkle in different places', () => {
  const spots = (seed: string): string =>
    dressSprite(spriteFor('oracle', 'mythic', 'adult'), 'mythic', seed, 0)
      .map((row) => [...row].map((cell) => (cell === 'A' ? 'A' : '.')).join(''))
      .join('');
  assert.notEqual(spots('plan:pl_77c'), spots('plan:pl_902'), 'the sparkle ignored the seed');
});

test('the rim light lands on every species, and leaves the eyes alone', () => {
  for (const species of EVERY_SPECIES) {
    const plain = spriteFor(species, rarityOf(species), 'adult');
    const grid = dressSprite(plain, rarityOf(species), 'seed', 0).join('');
    assert.ok(grid.includes('h'), `${species} came out unlit`);
    assert.ok(grid.includes('d'), `${species} came out unshaded`);
    assert.equal(
      [...grid].filter((cell) => cell === 'e').length,
      [...plain.join('')].filter((cell) => cell === 'e').length,
      `${species} lost or gained an eye`,
    );
  }
});
