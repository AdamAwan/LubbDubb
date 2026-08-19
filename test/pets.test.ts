import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { PetKeeper, type PetPolicy } from '../src/pets/keeper.js';
import { hash32, rollAction } from '../src/pets/roll.js';
import { beatsToNextStage, blendValue, petStage, resolveTier, SPECIES } from '../src/pets/catalogue.js';
import type { PetActionKind } from '../src/types.js';

const RARITY = { common: 700, uncommon: 200, rare: 80, mythic: 20 };
const POLICY: PetPolicy = {
  enabled: true,
  beatsPerDollar: 25,
  dropChance: 0.1,
  pity: 15,
  rarity: RARITY,
  blendYield: 500,
};

function keeper(policy: Partial<PetPolicy> = {}): { store: Store; pets: PetKeeper } {
  const store = new Store(':memory:');
  return { store, pets: new PetKeeper(store, { ...POLICY, ...policy }) };
}

/** A settled `ask`: a second kind of action, for the tests that need two. */
function settle(store: Store, title: string): string {
  const { task } = store.recordHumanTask({ title, detail: '', agentId: null, taskId: null, originRef: null });
  store.settleHumanTask(task.id, 'done', 'sorted');
  return task.id;
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
    firstEver: false,
    rarity: RARITY,
  });
  const again = rollAction('escalation', 'esc_9f2a', '2026-04-12T14:00:00.000Z', {
    dropChance: 0.5,
    forced: false,
    firstEver: false,
    rarity: RARITY,
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
  // The deployment's first action always hatches, so the miss under test is the second.
  answer(store, 'the first question ever asked');
  answer(store, 'a question nobody gets a pet for');
  assert.equal(pets.scan().length, 1, 'only the first-of-kind hatches at a zero chance');
  assert.equal(store.petActionsSinceHatch(), 1, 'a miss is a row, or the counter can never move');
});

test('pity forces a hatch once enough actions have missed', () => {
  const { store, pets } = keeper({ dropChance: 0, pity: 3 });
  // The first action ever, then three that would all miss — the third is forced.
  for (let i = 0; i < 4; i++) answer(store, `question ${i}`);
  const hatched = pets.scan();
  assert.equal(hatched.length, 2, 'the first action ever, and then the one pity forces');
  assert.equal(store.petActionsSinceHatch(), 0, 'and the counter resets behind it');
});

test('the deployment’s first action hatches, and draws something above a common', () => {
  const { store, pets } = keeper({ dropChance: 0 });
  answer(store, 'the first question ever asked');
  const [pet] = pets.scan();
  assert.ok(pet, 'the first action ever drops whatever the chance says');
  assert.notEqual(SPECIES[pet.species].rarity, 'common', 'and rolls on the table with the commons removed');
});

test('the guarantee is spent once, not once per kind of action', () => {
  // The bug this replaced: `firstOfKind` re-armed for every one of the seven
  // kinds, so an afternoon that touched each of them handed out seven pets —
  // and, because the guarantee strips the commons and most tables hold exactly
  // one non-common by day, handed out the *rare* tier while `nib` and `tuft`
  // stayed unreachable.
  const { store, pets } = keeper({ dropChance: 0, pity: 1_000 });
  answer(store, 'the first question ever asked');
  settle(store, 'a task of an entirely different kind');

  const hatched = pets.scan();
  assert.equal(hatched.length, 1, 'only the very first action ever is guaranteed');
  assert.equal(hatched[0]!.originKind, 'escalation', 'and it is the earliest one, not the newest kind');
});

test('a second scan does not re-arm the guarantee for an action rolled later', () => {
  // `seen` is read once per pass, so a flag derived from it and never advanced
  // would call every action in a first scan the deployment's first.
  const { store, pets } = keeper({ dropChance: 0, pity: 1_000 });
  answer(store, 'the first question ever asked');
  assert.equal(pets.scan().length, 1);

  answer(store, 'a question asked in a later pass entirely');
  assert.deepEqual(pets.scan(), [], 'the guarantee is gone, and a zero chance hatches nothing');
});

test('nocturne is drawn only by an action taken at night, in the action’s own hours', () => {
  const day = resolveTier('escalation', 'uncommon', 14)?.members ?? [];
  const night = resolveTier('escalation', 'uncommon', 2)?.members ?? [];
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
    const common = resolveTier(kind, 'common', 14);
    assert.ok(common !== null && common.members.length >= 3, `${kind} must carry three commons`);
    assert.ok(
      common.members.includes('pip') && common.members.includes('mote'),
      `${kind} must carry both universals, or a working style can go unrewarded for weeks`,
    );
    // Every tier must resolve to something, or a roll landing there hatches nothing.
    for (const tier of ['common', 'uncommon', 'rare', 'mythic'] as const)
      assert.ok(resolveTier(kind, tier, 14) !== null, `${kind} must resolve ${tier} to some tier`);
  }
});

test('the tier is rolled globally, so rarity is a fact about the deployment', () => {
  // The Mark One bug: rarity was an emergent accident of each action's weight
  // table, so "a rare is 8%" was true of no deployment. Stage 2 rolls one table
  // for every action, and only a pool that cannot fill a tier changes the answer.
  const counts: Record<string, number> = { common: 0, uncommon: 0, rare: 0, mythic: 0 };
  for (let i = 0; i < 4_000; i++) {
    const roll = rollAction('escalation', `esc_${i}`, '2026-04-12T14:00:00.000Z', {
      dropChance: 1,
      forced: false,
      firstEver: false,
      rarity: RARITY,
    });
    counts[SPECIES[roll.species].rarity] = (counts[SPECIES[roll.species].rarity] ?? 0) + 1;
  }
  // Escalation holds no mythic, so its 2% degrades into rare — 10%, not 8%.
  assert.ok(Math.abs(counts.common! / 4_000 - 0.7) < 0.05, `common should sit near 70%, saw ${counts.common}/4000`);
  assert.ok(
    Math.abs(counts.uncommon! / 4_000 - 0.2) < 0.05,
    `uncommon should sit near 20%, saw ${counts.uncommon}/4000`,
  );
  assert.equal(counts.mythic, 0, 'escalation holds no mythic, so it can never draw one');
});

test('a tier the pool cannot fill degrades downward, never up', () => {
  // `human-task` carries no rare and no mythic, so both fall to uncommon. Reaching
  // *up* instead would make the scarcest actions the easiest source of the
  // scarcest animals, which is the inversion this design removed.
  assert.equal(resolveTier('human-task', 'mythic', 14)?.tier, 'uncommon');
  assert.equal(resolveTier('human-task', 'rare', 14)?.tier, 'uncommon');
  // Only `upgrade` holds a mythic at all, and it keeps it.
  assert.equal(resolveTier('upgrade', 'mythic', 14)?.tier, 'mythic');
});

test('pity forces the hatch and never touches the tier', () => {
  // A pet you were given because you had been unlucky must be exactly as likely
  // to be a mythic as one the roll granted: paying out worse would make pity a
  // punishment, better would make waiting the strategy.
  for (let i = 0; i < 200; i++) {
    const ref = `job_${i}`;
    const rolled = rollAction('job', ref, '2026-04-12T14:00:00.000Z', {
      dropChance: 1,
      forced: false,
      firstEver: false,
      rarity: RARITY,
    });
    const forced = rollAction('job', ref, '2026-04-12T14:00:00.000Z', {
      dropChance: 0,
      forced: true,
      firstEver: false,
      rarity: RARITY,
    });
    assert.equal(forced.species, rolled.species, 'the same action must draw the same animal either way');
    assert.ok(forced.hatches && rolled.hatches);
  }
});

test('no common turns up often enough to bore you', () => {
  // One common per pool put `pip` at 70% of hatches on five of the seven actions.
  // Three per pool is what keeps any single animal near a fifth.
  const seen: Record<string, number> = {};
  const kinds: PetActionKind[] = ['escalation', 'human-task', 'plan', 'landing', 'job', 'finding', 'upgrade'];
  for (const kind of kinds)
    for (let i = 0; i < 700; i++) {
      const roll = rollAction(kind, `${kind}_${i}`, '2026-04-12T14:00:00.000Z', {
        dropChance: 1,
        forced: false,
        firstEver: false,
        rarity: RARITY,
      });
      seen[roll.species] = (seen[roll.species] ?? 0) + 1;
    }
  const total = kinds.length * 700;
  const worst = Math.max(...Object.values(seen)) / total;
  assert.ok(
    worst < 0.3,
    `no species may exceed 30% of hatches across a mixed workload, saw ${(worst * 100).toFixed(0)}%`,
  );
});

test('blending a duplicate credits beats and keeps the record', () => {
  const { store, pets } = keeper({ dropChance: 1, pity: 1_000 });
  // Two escalations at the same hour draw the same tier table; force a duplicate
  // by hatching two and finding a species with two live rows.
  for (let i = 0; i < 12; i++) answer(store, `question ${i}`);
  pets.scan();
  const all = store.listPets();
  const dupSpecies = all
    .map((pet) => pet.species)
    .find((species, _i, list) => list.filter((s) => s === species).length > 1);
  assert.ok(dupSpecies, 'twelve escalations must produce at least one duplicate species');
  const victim = all.find((pet) => pet.species === dupSpecies)!;

  const before = pets.state()!.wallet.earned;
  const result = pets.blend(victim.id);
  assert.equal(result.ok, true, 'a duplicate may be blended');

  const after = store.getPet(victim.id);
  assert.ok(after, 'the row survives the blend — its origin line is the point of the panel');
  assert.notEqual(after.dissolvedAt, null, 'and carries the stamp that says so');
  assert.equal(after.species, victim.species, 'keeping its species');
  assert.equal(after.originRef, victim.originRef, 'and its origin');
  assert.equal(after.placed, false, 'a dissolved pet does not hold a vivarium slot');
  assert.equal(pets.state()!.wallet.earned, before + blendValue(victim.species, 500), 'the credit lands in the wallet');
});

test('the last of a species is refused, and a dissolved one cannot be fed or re-blended', () => {
  const { store, pets } = keeper({ dropChance: 1, pity: 1_000 });
  answer(store, 'the only question');
  pets.scan();
  const [only] = store.listPets();
  assert.ok(only);
  const refused = pets.blend(only.id);
  assert.equal(refused.ok, false, 'blending is for duplicates — the last one stays');

  // And once something *is* dissolved it stops being a live pet in every sense.
  for (let i = 0; i < 12; i++) answer(store, `filler ${i}`);
  pets.scan();
  const dupes = store.listPets();
  const species = dupes.map((p) => p.species).find((s, _i, l) => l.filter((x) => x === s).length > 1)!;
  const victim = dupes.find((p) => p.species === species)!;
  assert.equal(pets.blend(victim.id).ok, true);
  assert.equal(pets.blend(victim.id).ok, false, 'a dissolved pet cannot be blended twice');
  assert.equal(pets.feed(victim.id, 10).ok, false, 'nor fed');
  assert.equal(pets.place(victim.id, true).ok, false, 'nor put out');
});

test('a database from before blending gains the column rather than reading undefined', () => {
  // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so `dissolved_at`
  // without its `ColumnMigrations` entry would be invisible on every database from
  // before blending — and invisible here means every historical pet reads as alive
  // again. Built against the *old* shape on purpose: a fresh database gets the
  // column from `SCHEMA` and would pass this test without the migration existing.
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pets-'));
  const file = join(dir, 'before-blending.sqlite');
  try {
    const old = new Database(file);
    old.exec(`CREATE TABLE pets (
      id TEXT PRIMARY KEY, species TEXT NOT NULL, seed TEXT NOT NULL, name TEXT,
      fed INTEGER NOT NULL DEFAULT 0, origin_kind TEXT NOT NULL, origin_ref TEXT NOT NULL,
      hatched_at TEXT NOT NULL, placed INTEGER NOT NULL DEFAULT 0,
      UNIQUE (origin_kind, origin_ref))`);
    old
      .prepare(
        `INSERT INTO pets (id, species, seed, name, fed, origin_kind, origin_ref, hatched_at, placed)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run('pet_old', 'pip', 'escalation:esc_1', null, 0, 'escalation', 'esc_1', '2026-01-01T00:00:00.000Z', 1);
    old.close();

    const store = new Store(file);
    const pet = store.getPet('pet_old');
    assert.ok(pet, 'the historical row survives the migration');
    assert.equal(pet.dissolvedAt, null, 'and reads as alive rather than undefined');
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
