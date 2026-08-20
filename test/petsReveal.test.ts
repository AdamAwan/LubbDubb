import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PetSpecies, PetStage, PetView } from '../web/src/types.js';
import { PET_STAGES, speciesKnown, speciesSeen } from '../web/src/pets/reveal.js';

/**
 * What the catalogue is allowed to have seen.
 *
 * The failure this guards is silent in both directions and neither renders wrong:
 * a shell counted as a sighting fills the collection with animals nobody has been
 * shown, and a stage revealed off a sibling's — or off ownership alone — draws the
 * adult of a pet still in the vivarium as a hatchling. The page reads perfectly
 * either way. → `docs/spec/22-pets.md#what-it-withholds`
 */

function pet(over: Partial<PetView> = {}): PetView {
  return {
    id: 'pet_1',
    species: 'pip',
    seed: 'escalation:esc_Jdt9l826iQ',
    name: null,
    fed: 0,
    originKind: 'escalation',
    originRef: 'esc_Jdt9l826iQ',
    originLabel: null,
    hatchedAt: new Date(1_700_000_000_000).toISOString(),
    openedAt: new Date(1_700_000_000_000).toISOString(),
    placed: false,
    dissolvedAt: null,
    builtSha: null,
    builtClean: false,
    chain: null,
    rarity: 'common',
    display: 'pip',
    stage: 'hatchling',
    beatsToNextStage: 500,
    flaw: null,
    provenance: 'unknown',
    ...over,
  };
}

const stages = (seen: Map<PetSpecies, Set<PetStage>>, species: PetSpecies): PetStage[] =>
  PET_STAGES.filter((stage) => seen.get(species)?.has(stage) === true);

test('an unopened egg has shown nothing', () => {
  const seen = speciesSeen([pet({ openedAt: null, stage: 'adult', species: 'ouroboros' })]);
  assert.equal(seen.has('ouroboros'), false);
});

test('a pet shows the stage it has reached and every one below it', () => {
  const seen = speciesSeen([pet({ stage: 'juvenile' })]);
  assert.deepEqual(stages(seen, 'pip'), ['hatchling', 'juvenile']);
});

test('a stage nobody has raised one to stays unseen', () => {
  const seen = speciesSeen([pet({ stage: 'hatchling' })]);
  assert.deepEqual(stages(seen, 'pip'), ['hatchling']);
});

test('a species is not shown by a sibling of its tier', () => {
  const seen = speciesSeen([pet({ species: 'pip', stage: 'adult' })]);
  assert.equal(seen.has('mote'), false);
});

test('the highest of several wins, and a blended one still counts', () => {
  const seen = speciesSeen([
    pet({ id: 'pet_1', stage: 'hatchling' }),
    pet({ id: 'pet_2', stage: 'adult', dissolvedAt: new Date(1_700_000_100_000).toISOString() }),
  ]);
  assert.deepEqual(stages(seen, 'pip'), ['hatchling', 'juvenile', 'adult']);
});

test('naming a species is the juvenile’s to give, as it is for one pet', () => {
  for (const stage of PET_STAGES) {
    const one = pet({ stage });
    const seen = speciesSeen([one]);
    assert.equal(seen.get('pip')?.has('juvenile') === true, speciesKnown(one), stage);
  }
});
