import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../src/store/store.js';
import { PetKeeper, type PetPolicy } from '../src/pets/keeper.js';
import { hash32, rollAction } from '../src/pets/roll.js';
import { beatsToNextStage, petStage, SPECIES, tableFor } from '../src/pets/catalogue.js';
import type { PetActionKind } from '../src/types.js';

const POLICY: PetPolicy = { enabled: true, beatsPerDollar: 25, dropChance: 0.1, pity: 15 };

function keeper(policy: Partial<PetPolicy> = {}): { store: Store; pets: PetKeeper } {
  const store = new Store(':memory:');
  return { store, pets: new PetKeeper(store, { ...POLICY, ...policy }) };
}

/** An answered escalation: the cleanest operator action in the harness. */
function answer(store: Store, prompt: string): string {
  const escalation = store.createEscalation({
    type: 'answer_question',
    prompt,
    context: {},
    agentId: null,
    taskId: null,
  });
  store.answerEscalation(escalation.id, 'go ahead');
  return escalation.id;
}

test('the roll is a pure function of the action, so re-reading it is free', () => {
  const first = rollAction('escalation', 'esc_9f2a', '2026-04-12T14:00:00.000Z', {
    dropChance: 0.5,
    forced: false,
    firstOfKind: false,
  });
  const again = rollAction('escalation', 'esc_9f2a', '2026-04-12T14:00:00.000Z', {
    dropChance: 0.5,
    forced: false,
    firstOfKind: false,
  });
  assert.deepEqual(first, again, 'the same action must always come to the same answer');
  assert.equal(hash32('escalation:esc_9f2a'), hash32('escalation:esc_9f2a'));
});

test('scanning twice hatches nothing the second time', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'which branch keeps the slot?');

  const first = pets.scan();
  assert.equal(first.length, 1, 'a certain drop chance hatches on the first pass');
  const second = pets.scan();
  assert.deepEqual(second, [], 'the second pass over the same world writes nothing');
  assert.equal(store.listPets().length, 1);
});

test('an action that hatched nothing is still recorded, so pity can count it', () => {
  const { store, pets } = keeper({ dropChance: 0, pity: 1_000 });
  // The first of a kind always hatches, so the miss under test is the second.
  answer(store, 'the first question ever asked');
  answer(store, 'a question nobody gets a pet for');
  assert.equal(pets.scan().length, 1, 'only the first-of-kind hatches at a zero chance');
  assert.equal(store.petActionsSinceHatch(), 1, 'a miss is a row, or the counter can never move');
});

test('pity forces a hatch once enough actions have missed', () => {
  const { store, pets } = keeper({ dropChance: 0, pity: 3 });
  // One first-of-kind, then three that would all miss — the third is forced.
  for (let i = 0; i < 4; i++) answer(store, `question ${i}`);
  const hatched = pets.scan();
  assert.equal(hatched.length, 2, 'the first-of-kind, and then the one pity forces');
  assert.equal(store.petActionsSinceHatch(), 0, 'and the counter resets behind it');
});

test('the first action of a kind hatches, and draws something above a common', () => {
  const { store, pets } = keeper({ dropChance: 0 });
  answer(store, 'the first question ever asked');
  const [pet] = pets.scan();
  assert.ok(pet, 'a first-of-kind drops whatever the chance says');
  assert.notEqual(SPECIES[pet.species].rarity, 'common', 'and rolls on the table with the commons removed');
});

test('nocturne is drawn only by an action taken at night, in the action’s own hours', () => {
  const day = tableFor('escalation', 14, false).map((entry) => entry.species);
  const night = tableFor('escalation', 2, false).map((entry) => entry.species);
  assert.ok(!day.includes('nocturne'), 'a 2pm answer cannot draw the night animal');
  assert.ok(night.includes('nocturne'), 'a 2am one can');
});

test('a stage is derived from what a pet has been fed, and rarity slows it down', () => {
  assert.equal(petStage('pip', 0), 'hatchling');
  assert.equal(petStage('pip', 1_500), 'juvenile');
  assert.equal(petStage('pip', 8_000), 'adult');
  // The same beats leave a mythic further back, which is what makes it feel rare.
  assert.equal(petStage('ouroboros', 8_000), 'juvenile');
  assert.equal(beatsToNextStage('pip', 8_000), null, 'an adult owes nothing');
});

test('beats are derived from spend, and feeding refuses more than there is', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'hatch me something');
  const [pet] = pets.scan();
  assert.ok(pet);

  const broke = pets.feed(pet.id, 100);
  assert.equal(broke.ok, false, 'a fleet that has spent nothing has nothing to feed with');

  // One dollar of recorded usage, at the default rate, is 25 beats.
  const agent = store.createAgent({ taskId: 'task_1', cwd: '.', pid: null, sessionId: null });
  store.recordAgentUsage(agent.id, {
    costUsd: 1,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
  });
  const state = pets.state();
  assert.equal(state?.wallet.earned, 25);

  assert.equal(pets.feed(pet.id, 26).ok, false, 'and 26 is more than 25');
  const fed = pets.feed(pet.id, 25);
  assert.equal(fed.ok, true);
  assert.equal(pets.state()?.wallet.balance, 0, 'the balance is the subtraction, not a stored column');
  assert.equal(store.getPet(pet.id)?.fed, 25);
});

test('the vivarium refuses a fifth pet rather than evicting one', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  for (let i = 0; i < 5; i++) answer(store, `question ${i}`);
  pets.scan();
  const all = store.listPets();
  assert.equal(all.length, 5);
  assert.equal(all.filter((p) => p.placed).length, 4, 'the first four stand out; the fifth waits');
  const spare = all.find((p) => !p.placed);
  assert.ok(spare);
  const refused = pets.place(spare.id, true);
  assert.equal(refused.ok, false, 'putting a fifth out is refused, not silently swapped');
});

test('an empty name puts the species’ own back', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'name me');
  const [pet] = pets.scan();
  assert.ok(pet);
  assert.equal(pets.rename(pet.id, 'Bramble').ok, true);
  assert.equal(store.getPet(pet.id)?.name, 'Bramble');
  pets.rename(pet.id, null);
  assert.equal(store.getPet(pet.id)?.name, null, 'cleared, so the card falls back to the display name');
});

test('turning pets off scans nothing and reports nothing, and deletes nothing', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'hatch me something');
  pets.scan();
  assert.equal(store.listPets().length, 1);

  const off = new PetKeeper(store, { ...POLICY, enabled: false });
  assert.deepEqual(off.scan(), []);
  assert.equal(off.state(), null, 'the cockpit draws nothing rather than an empty enclosure');
  assert.equal(off.feed('anything', 1).ok, false);
  assert.equal(store.listPets().length, 1, 'and what hatched is still there');
});

test('every action kind can draw something, so no action is a dead end', () => {
  const kinds: PetActionKind[] = ['escalation', 'human-task', 'plan', 'landing', 'job', 'finding', 'upgrade'];
  for (const kind of kinds) {
    const table = tableFor(kind, 14, false);
    assert.ok(table.length > 0, `${kind} must be able to draw something`);
    assert.ok(
      table.some((entry) => entry.species === 'pip'),
      `${kind} must include the common, or a working style can go unrewarded for weeks`,
    );
  }
});

test('pets are a lens: nothing in the dispatcher reads them', () => {
  const dispatcherFiles = srcFiles('src/dispatcher');
  for (const file of dispatcherFiles) {
    assert.ok(
      !readFileSync(file, 'utf8').includes('pets/'),
      `${file} must not read the vivarium — it is written from what an operator already did, and a rule reading it back would be the harness marking its own homework`,
    );
  }
  assert.ok(dispatcherFiles.length > 0, 'the walk must actually have files to check');
});

test('no agent is ever told a pet exists', () => {
  // The prompts and the tool channel are the two surfaces an agent reads. A score
  // an agent can see is a target it can optimise, and the whole feature rests on
  // it being invisible to the fleet.
  for (const dir of ['src/dispatcher', 'src/mcp', 'docs/prompt-templates']) {
    for (const file of allFiles(dir)) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      assert.ok(!text.includes('vivarium'), `${file} must not mention the vivarium to an agent`);
    }
  }
});

test('the roll never reaches for randomness', () => {
  for (const file of srcFiles('src/pets')) {
    // Comments stripped first: this file's own prose argues against `Math.random`
    // by name, and an assertion that could not tell the argument from the call
    // would be one nobody could write the argument down beside.
    assert.ok(
      !stripComments(readFileSync(file, 'utf8')).includes('Math.random'),
      `${file} must stay deterministic — a random roll turns every re-read into a fresh chance at a pet`,
    );
  }
});

/** Source with block and line comments removed, so prose about a call is not the call. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `.ts` under a source directory, recursively, as repo-relative paths. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

/** The same walk, for directories holding prose rather than TypeScript. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...allFiles(path));
    else out.push(path);
  }
  return out.sort();
}
