import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { PetKeeper } from '../src/pets/keeper.js';
import { attestPet, provenanceOf, replayBarren, replayChain, type PetLedger } from '../src/pets/attest.js';
import { hash32, rollAction, speciesCandidates } from '../src/pets/roll.js';
import { PET_RULES, type PetActionRate, type PetRules } from '../src/pets/rules.js';
import { beatsToNextStage, blendValue, petStage, resolveTier, SPECIES } from '../src/pets/catalogue.js';
import type { Pet, PetActionKind } from '../src/types.js';

type RuleOverrides = Partial<Omit<PetRules, 'rates'>> & Partial<PetActionRate> & { rates?: PetRules['rates'] };

function rules(over: RuleOverrides = {}): PetRules {
  const { dropChance, pity, rates, ...rest } = over;
  const spread = Object.fromEntries(
    (Object.keys(PET_RULES.rates) as PetActionKind[]).map((kind) => [
      kind,
      {
        dropChance: dropChance ?? PET_RULES.rates[kind].dropChance,
        pity: pity ?? PET_RULES.rates[kind].pity,
      },
    ]),
  ) as PetRules['rates'];
  return { ...PET_RULES, ...rest, rates: rates ?? spread };
}

function coldKeeper(over: RuleOverrides = {}, build = BUILD): { store: Store; pets: PetKeeper } {
  const store = new Store(':memory:');
  return { store, pets: new PetKeeper(store, { enabled: true, visible: true }, rules(over), () => build) };
}

function keeper(over: RuleOverrides = {}, build = BUILD): { store: Store; pets: PetKeeper } {
  const { store, pets } = coldKeeper(over, build);
  pets.scan();
  return { store, pets };
}

const BUILD = { sha: 'build_one', clean: true };

function ledger(store: Store, build = BUILD): PetLedger {
  return {
    actions: store.petActionIndex(),
    paid: store.petPaidTotals(),
    chain: replayChain(store.petChainLog()),
    barren: replayBarren(store.petActionLog(), PET_RULES, started(store)),
    build,
  };
}

function started(store: Store): string {
  const at = store.vivariumStart();
  assert.ok(at !== null, 'a scan stamps the start, and every keeper here has scanned');
  return at;
}

const KINDS: PetActionKind[] = ['escalation', 'human-task', 'plan', 'landing', 'job', 'claim', 'upgrade'];

const LIVE_KINDS: PetActionKind[] = KINDS.filter((kind) => kind !== 'claim');

function settle(store: Store, title: string): string {
  const { task } = store.recordHumanTask({ title, detail: '', agentId: null, taskId: null, originRef: null });
  store.settleHumanTask(task.id, 'done', 'sorted');
  return task.id;
}

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
  const opts = { rules: rules({ dropChance: 0.5 }), forced: false, firstEver: false };
  const first = rollAction('escalation', 'esc_9f2a', '2026-04-12T14:00:00.000Z', opts);
  const again = rollAction('escalation', 'esc_9f2a', '2026-04-12T14:00:00.000Z', opts);
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
  answer(store, 'the first question ever asked');
  answer(store, 'a question nobody gets a pet for');
  assert.equal(pets.scan().length, 1, 'only the first-of-kind hatches at a zero chance');
  assert.equal(
    store.petActionsSinceHatch(started(store)).get('escalation'),
    1,
    'a miss is a row, or the counter can never move',
  );
});

test('pity forces a hatch once enough actions have missed', () => {
  const { store, pets } = keeper({ dropChance: 0, pity: 3 });
  for (let i = 0; i < 4; i++) answer(store, `question ${i}`);
  const hatched = pets.scan();
  assert.equal(hatched.length, 2, 'the first action ever, and then the one pity forces');
  assert.equal(
    store.petActionsSinceHatch(started(store)).get('escalation') ?? 0,
    0,
    'and the counter resets behind it',
  );
});

test('pity is counted per kind, so a busy action cannot spend a quiet one’s floor', () => {
  const { store, pets } = keeper({ dropChance: 0, pity: 3 });
  answer(store, 'the first action ever, which is guaranteed');
  pets.scan();

  answer(store, 'escalation one');
  for (let i = 0; i < 10; i++) settle(store, `task ${i}`);
  pets.scan();

  const byKind = store.petActionsSinceHatch(started(store));
  assert.equal(byKind.get('escalation'), 1, 'the escalation counter counts escalations only');
  assert.ok((byKind.get('human-task') ?? 0) > 0, 'and the task counter runs on its own');
  const hatched = store.listPets().filter((pet) => pet.originKind === 'escalation' && pet.originRef !== undefined);
  assert.ok(hatched.length >= 1, 'the guaranteed first one is still the only escalation pet');
});

test('a quiet action is worth more than a busy one', () => {
  const { rates } = PET_RULES;
  assert.ok(rates.upgrade.dropChance > rates.landing.dropChance, 'an upgrade is scarcer than a landing');
  assert.ok(rates.landing.dropChance > rates.plan.dropChance, 'a landing is scarcer than a plan');
  assert.ok(rates.plan.dropChance > rates['human-task'].dropChance, 'a plan is scarcer than a task');
  assert.ok(rates['human-task'].dropChance > rates.finding.dropChance, 'a task is scarcer than a finding');
  assert.ok(rates.finding.dropChance > rates.job.dropChance, 'and a finding is scarcer than a job launch');

  for (const kind of KINDS)
    assert.ok(
      Math.abs(rates[kind].pity - 2 / rates[kind].dropChance) <= 4,
      `${kind} pity must be about twice its own expected gap, saw ${rates[kind].pity}`,
    );
});

test('every action is a route to a mythic, and each mythic to one action', () => {
  const owners = new Map<string, PetActionKind[]>();
  for (const kind of KINDS) {
    const landed = resolveTier(kind, 'mythic', 14);
    assert.equal(landed?.tier, 'mythic', `${kind} must be a route to a mythic of its own`);
    for (const species of landed.members) owners.set(species, [...(owners.get(species) ?? []), kind]);
  }
  for (const [species, kinds] of owners)
    assert.equal(kinds.length, 1, `${species} must belong to one action, not ${kinds.join(' and ')}`);
  assert.equal(owners.size, KINDS.length, 'one mythic per action, and no action sharing');
});

test('the deployment’s first action hatches, and draws something above a common', () => {
  const { store, pets } = keeper({ dropChance: 0 });
  answer(store, 'the first question ever asked');
  const [pet] = pets.scan();
  assert.ok(pet, 'the first action ever drops whatever the chance says');
  assert.notEqual(SPECIES[pet.species].rarity, 'common', 'and rolls on the table with the commons removed');
});

test('the guarantee is spent once, not once per kind of action', () => {
  const { store, pets } = keeper({ dropChance: 0, pity: 1_000 });
  answer(store, 'the first question ever asked');
  settle(store, 'a task of an entirely different kind');

  const hatched = pets.scan();
  assert.equal(hatched.length, 1, 'only the very first action ever is guaranteed');
  assert.equal(hatched[0]!.originKind, 'escalation', 'and it is the earliest one, not the newest kind');
});

test('a second scan does not re-arm the guarantee for an action rolled later', () => {
  const { store, pets } = keeper({ dropChance: 0, pity: 1_000 });
  answer(store, 'the first question ever asked');
  assert.equal(pets.scan().length, 1);

  answer(store, 'a question asked in a later pass entirely');
  assert.deepEqual(pets.scan(), [], 'the guarantee is gone, and a zero chance hatches nothing');
});

const BEFORE_EVERYTHING = '0000-01-01T00:00:00.000Z';

test('a backlog from before the vivarium started is recorded, and pays for nothing', () => {
  const { store, pets } = coldTimedKeeper({ dropChance: 0, pity: 1_000 });
  answer(store, 'answered five days before the upgrade');
  settle(store, 'a task from before pets existed');

  assert.deepEqual(pets.scan(), [], 'a deployment’s whole history is not one afternoon’s work');
  assert.deepEqual(store.listPets(), []);
  const log = store.petActionLog();
  assert.equal(log.length, 2, 'recorded all the same, or they stay fresh forever');
  assert.deepEqual(
    log.map((row) => row.petId),
    [null, null],
    'inert rather than pending: written with no pet',
  );
  assert.deepEqual(
    [...store.petActionsSinceHatch(started(store)).values()],
    [],
    'and lending no pity floor to whatever comes next',
  );

  const first = answer(store, 'the first thing done with the vivarium open');
  const hatched = pets.scan();
  assert.equal(hatched.length, 1, 'the guarantee is still there at a zero drop chance');
  assert.equal(hatched[0]?.originRef, first, 'and it falls on the first action after the start, not the oldest row');
});

test('a clearance re-stamps the start, so what it leaves standing lends nothing', () => {
  const { store, pets } = timedKeeper({ dropChance: 0, pity: 1_000 });
  answer(store, 'the first question ever asked');
  assert.equal(pets.scan().length, 1, 'the deployment’s one guarantee');
  for (let i = 0; i < 5; i++) answer(store, `question ${i}`);
  pets.scan();
  const before = started(store);

  const reset = pets.resetOnce();
  assert.ok(reset);
  assert.equal(store.vivariumStart(), reset.at, 'the start moves to the clearance');
  assert.ok(reset.at > before, 'which is later than where the vivarium began');
  assert.deepEqual(
    [...store.petActionsSinceHatch(started(store)).values()],
    [],
    'the six actions it left standing are behind the new start, so no floor is inherited',
  );

  answer(store, 'the first thing done after the clearance');
  assert.equal(pets.scan().length, 1, 'and the first-action guarantee comes back with the start');
});

test('a vivarium carried over from before the boundary keeps every pet it has', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vivarium-'));
  const path = join(dir, 'old.db');
  let tick = 0;
  const clock = (): string => new Date(Date.parse('2026-04-12T09:00:00.000Z') + tick++ * 60_000).toISOString();
  try {
    const store = new Store(path, clock);
    const pets = new PetKeeper(store, { enabled: true, visible: true }, rules({ dropChance: 0.5 }), () => BUILD);
    pets.scan();
    for (let i = 0; i < 20; i++) answer(store, `question ${i}`);
    for (let i = 0; i < 20; i++) settle(store, `task ${i}`);
    pets.scan();
    const collection = store.listPets().map((pet) => pet.id);
    assert.ok(collection.length > 1, 'a collection worth carrying over');
    const log = store.petActionLog();
    const earliest = log.map((row) => row.at).sort()[0];
    const barren = [...replayBarren(log, PET_RULES, BEFORE_EVERYTHING)].sort();
    store.close();

    const raw = new Database(path);
    raw.exec(`DELETE FROM pet_vivarium`);
    raw.close();

    const rebooted = new Store(path, clock);
    const back = new PetKeeper(rebooted, { enabled: true, visible: true }, rules({ dropChance: 0.5 }), () => BUILD);
    assert.deepEqual(back.scan(), [], 'nothing is rolled a second time');
    assert.equal(rebooted.vivariumStart(), earliest, 'the start is the earliest action already rolled');
    assert.deepEqual(
      rebooted.listPets().map((pet) => pet.id),
      collection,
      'and the collection is exactly the one from before',
    );
    assert.deepEqual(
      [...replayBarren(rebooted.petActionLog(), PET_RULES, started(rebooted))].sort(),
      barren,
      'the replay says precisely what it said when it had no boundary to honour',
    );
    assert.deepEqual(
      back.state()?.pets.filter((pet) => pet.flaw !== null),
      [],
      'so no pet that was honestly earned draws a flaw badge on the boot that takes this build',
    );
    rebooted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(petStage('ouroboros', 8_000), 'juvenile');
  assert.equal(beatsToNextStage('pip', 8_000), null, 'an adult owes nothing');
});

test('beats are derived from spend, and feeding refuses more than there is', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'hatch me something');
  const [pet] = pets.scan();
  assert.ok(pet);
  assert.equal(pets.open(pet.id).ok, true);

  const broke = pets.feed(pet.id, 100);
  assert.equal(broke.ok, false, 'a fleet that has spent nothing has nothing to feed with');

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

  const off = new PetKeeper(store, { enabled: false, visible: true });
  assert.deepEqual(off.scan(), []);
  assert.equal(off.state(), null, 'the cockpit draws nothing rather than an empty enclosure');
  assert.equal(off.feed('anything', 1).ok, false);
  assert.equal(store.listPets().length, 1, 'and what hatched is still there');
});

test('hiding pets draws nothing and stops nothing', () => {
  const store = new Store(':memory:');
  const hidden = new PetKeeper(store, { enabled: true, visible: false }, rules({ dropChance: 1 }), () => BUILD);
  hidden.scan();
  answer(store, 'hatch me something nobody is looking at');

  assert.equal(hidden.scan().length, 1, 'the scan still runs and the roll still lands');
  assert.equal(hidden.state(), null, 'and the cockpit is handed the same null the feature being off ships');

  const shown = new PetKeeper(store, { enabled: true, visible: true }, rules({ dropChance: 1 }), () => BUILD);
  assert.equal(shown.state()?.pets.length, 1, 'what accrued out of sight is there when it comes back');
});

test('every action kind can draw something, so no action is a dead end', () => {
  for (const kind of KINDS) {
    const common = resolveTier(kind, 'common', 14);
    assert.ok(common !== null && common.members.length >= 3, `${kind} must carry three commons`);
    assert.ok(
      common.members.includes('pip') && common.members.includes('mote'),
      `${kind} must carry both universals, or a working style can go unrewarded for weeks`,
    );
    for (const tier of ['common', 'uncommon', 'rare', 'mythic'] as const)
      assert.ok(resolveTier(kind, tier, 14) !== null, `${kind} must resolve ${tier} to some tier`);
  }
});

test('the tier is rolled globally, so rarity is a fact about the deployment', () => {
  const counts: Record<string, number> = { common: 0, uncommon: 0, rare: 0, mythic: 0 };
  for (let i = 0; i < 4_000; i++) {
    const roll = rollAction('escalation', `esc_${i}`, '2026-04-12T14:00:00.000Z', {
      rules: rules({ dropChance: 1 }),
      forced: false,
      firstEver: false,
    });
    counts[SPECIES[roll.species].rarity] = (counts[SPECIES[roll.species].rarity] ?? 0) + 1;
  }
  assert.ok(Math.abs(counts.common! / 4_000 - 0.7) < 0.05, `common should sit near 70%, saw ${counts.common}/4000`);
  assert.ok(
    Math.abs(counts.uncommon! / 4_000 - 0.2) < 0.05,
    `uncommon should sit near 20%, saw ${counts.uncommon}/4000`,
  );
  assert.ok(Math.abs(counts.rare! / 4_000 - 0.08) < 0.03, `rare should sit near 8%, saw ${counts.rare}/4000`);
  assert.ok(Math.abs(counts.mythic! / 4_000 - 0.02) < 0.02, `mythic should sit near 2%, saw ${counts.mythic}/4000`);
});

test('every action carries a full ladder, so no shipped roll degrades', () => {
  for (const kind of KINDS)
    for (const tier of ['common', 'uncommon', 'rare', 'mythic'] as const)
      assert.equal(resolveTier(kind, tier, 14)?.tier, tier, `${kind} must fill ${tier} itself, not by degrading`);
});

test('degrading still walks downward, never up', () => {
  const gated = resolveTier('escalation', 'uncommon', 14);
  assert.ok(gated !== null && !gated.members.includes('nocturne'), 'the day filter drops nocturne');
  assert.equal(gated.tier, 'uncommon', 'and what is left still fills the tier');
});

test('pity forces the hatch and never touches the tier', () => {
  for (let i = 0; i < 200; i++) {
    const ref = `job_${i}`;
    const rolled = rollAction('job', ref, '2026-04-12T14:00:00.000Z', {
      rules: rules({ dropChance: 1 }),
      forced: false,
      firstEver: false,
    });
    const forced = rollAction('job', ref, '2026-04-12T14:00:00.000Z', {
      rules: rules({ dropChance: 0 }),
      forced: true,
      firstEver: false,
    });
    assert.equal(forced.species, rolled.species, 'the same action must draw the same animal either way');
    assert.ok(forced.hatches && rolled.hatches);
  }
});

test('no common turns up often enough to bore you', () => {
  const seen: Record<string, number> = {};
  for (const kind of KINDS)
    for (let i = 0; i < 700; i++) {
      const roll = rollAction(kind, `${kind}_${i}`, '2026-04-12T14:00:00.000Z', {
        rules: rules({ dropChance: 1 }),
        forced: false,
        firstEver: false,
      });
      seen[roll.species] = (seen[roll.species] ?? 0) + 1;
    }
  const total = KINDS.length * 700;
  const worst = Math.max(...Object.values(seen)) / total;
  assert.ok(
    worst < 0.3,
    `no species may exceed 30% of hatches across a mixed workload, saw ${(worst * 100).toFixed(0)}%`,
  );
});

test('blending a duplicate credits beats and keeps the record', () => {
  const { store, pets } = keeper({ dropChance: 1, pity: 1_000 });
  for (let i = 0; i < 12; i++) answer(store, `question ${i}`);
  pets.scan();
  const all = store.listPets();
  const dupSpecies = all
    .map((pet) => pet.species)
    .find((species, _i, list) => list.filter((s) => s === species).length > 1);
  assert.ok(dupSpecies, 'twelve escalations must produce at least one duplicate species');
  const victim = all.find((pet) => pet.species === dupSpecies)!;

  assert.equal(pets.blend(victim.id).ok, false, 'an unopened shell is not a duplicate yet');
  assert.equal(pets.open(victim.id).ok, true);

  const before = pets.state()!.wallet.earned;
  const result = pets.blend(victim.id);
  assert.equal(result.ok, true, 'a duplicate may be blended');

  const after = store.getPet(victim.id);
  assert.ok(after, 'the row survives the blend — its origin line is the point of the panel');
  assert.notEqual(after.dissolvedAt, null, 'and carries the stamp that says so');
  assert.equal(after.species, victim.species, 'keeping its species');
  assert.equal(after.originRef, victim.originRef, 'and its origin');
  assert.equal(after.placed, false, 'a dissolved pet does not hold a vivarium slot');
  assert.equal(
    pets.state()!.wallet.earned,
    before + blendValue(victim.species, PET_RULES.blendYield),
    'the credit lands in the wallet',
  );
});

test('the last of a species is refused, and a dissolved one cannot be fed or re-blended', () => {
  const { store, pets } = keeper({ dropChance: 1, pity: 1_000 });
  answer(store, 'the only question');
  pets.scan();
  const [only] = store.listPets();
  assert.ok(only);
  assert.equal(pets.open(only.id).ok, true);
  const refused = pets.blend(only.id);
  assert.equal(refused.ok, false, 'blending is for duplicates — the last one stays');

  for (let i = 0; i < 12; i++) answer(store, `filler ${i}`);
  pets.scan();
  const dupes = store.listPets();
  const species = dupes.map((p) => p.species).find((s, _i, l) => l.filter((x) => x === s).length > 1)!;
  const victim = dupes.find((p) => p.species === species)!;
  assert.equal(pets.open(victim.id).ok, true);
  assert.equal(pets.blend(victim.id).ok, true);
  assert.equal(pets.blend(victim.id).ok, false, 'a dissolved pet cannot be blended twice');
  assert.equal(pets.feed(victim.id, 10).ok, false, 'nor fed');
  assert.equal(pets.place(victim.id, true).ok, false, 'nor put out');
});

function coldTimedKeeper(over: RuleOverrides = {}): { store: Store; pets: PetKeeper } {
  let tick = 0;
  const store = new Store(':memory:', () =>
    new Date(Date.parse('2026-04-12T09:00:00.000Z') + tick++ * 60_000).toISOString(),
  );
  return { store, pets: new PetKeeper(store, { enabled: true, visible: true }, rules(over), () => BUILD) };
}

function timedKeeper(over: RuleOverrides = {}): { store: Store; pets: PetKeeper } {
  const { store, pets } = coldTimedKeeper(over);
  pets.scan();
  return { store, pets };
}

function spend(store: Store, costUsd: number): void {
  const agent = store.createAgent({ taskId: `task_${costUsd}`, cwd: '.', pid: null, sessionId: null });
  store.recordAgentUsage(agent.id, {
    costUsd,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
  });
}

test('a drop arrives as an egg, and opening it reveals rather than decides', () => {
  const { store, pets } = timedKeeper({ dropChance: 1 });
  answer(store, 'hatch me something');
  const [pet] = pets.scan();
  assert.ok(pet);
  assert.equal(pet.openedAt, null, 'a drop is a shell until somebody opens it');

  const opened = pets.open(pet.id);
  assert.equal(opened.ok, true);
  const after = store.getPet(pet.id)!;
  assert.notEqual(after.openedAt, null, 'and the stamp is the whole of what opening writes');

  assert.equal(after.species, pet.species, 'the species is the one the roll landed on');
  assert.equal(after.seed, pet.seed, 'and so are its colours');
  assert.equal(after.chain, pet.chain, 'and the chain does not cover the shell coming off');

  const again = pets.open(pet.id);
  assert.equal(again.ok, true, 'a second open is a success — a double click is not an error');
  assert.equal(store.getPet(pet.id)?.openedAt, after.openedAt, 'and it does not move the stamp');
});

test('an egg cannot be fed or blended, and can still be put out', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  spend(store, 1);
  for (let i = 0; i < 12; i++) answer(store, `question ${i}`);
  pets.scan();
  const all = store.listPets();
  const species = all.map((p) => p.species).find((s, _i, l) => l.filter((x) => x === s).length > 1)!;
  const egg = all.find((p) => p.species === species)!;

  const fed = pets.feed(egg.id, 25);
  assert.match(fed.ok ? '' : fed.error, /still an egg/);
  const blended = pets.blend(egg.id);
  assert.match(blended.ok ? '' : blended.error, /still an egg/);
  assert.equal(store.getPet(egg.id)?.fed, 0, 'and nothing was spent on it');
  assert.equal(store.getPet(egg.id)?.dissolvedAt, null, 'nor lost');

  const standing = store.listPets().find((p) => p.placed)!;
  assert.equal(pets.place(standing.id, false).ok, true);
  assert.equal(pets.place(egg.id, true).ok, true);
});

test('a vivarium from before eggs is not turned back into a crate of shells', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-eggs-'));
  const path = join(dir, 'old.db');
  try {
    const old = new Database(path);
    old.exec(`CREATE TABLE pets (
      id TEXT PRIMARY KEY, species TEXT NOT NULL, seed TEXT NOT NULL, name TEXT,
      fed INTEGER NOT NULL DEFAULT 0, origin_kind TEXT NOT NULL, origin_ref TEXT NOT NULL,
      hatched_at TEXT NOT NULL, placed INTEGER NOT NULL DEFAULT 0, dissolved_at TEXT,
      built_sha TEXT, built_clean INTEGER NOT NULL DEFAULT 0, chain TEXT,
      UNIQUE (origin_kind, origin_ref))`);
    old
      .prepare(
        `INSERT INTO pets (id, species, seed, fed, origin_kind, origin_ref, hatched_at, placed)
         VALUES ('pet_old', 'pip', 'escalation:esc_old', 4000, 'escalation', 'esc_old', '2026-01-02T03:04:05.000Z', 1)`,
      )
      .run();
    old.close();

    const store = new Store(path);
    assert.equal(
      store.getPet('pet_old')?.openedAt,
      '2026-01-02T03:04:05.000Z',
      'a pet raised before the shell existed was revealed when it dropped, and is stamped so',
    );

    const pets = new PetKeeper(store, { enabled: true, visible: true }, rules({ dropChance: 1 }), () => BUILD);
    pets.scan();
    answer(store, 'a question after the upgrade');
    const [fresh] = pets.scan();
    assert.ok(fresh);
    assert.equal(fresh.openedAt, null);
    store.close();

    const rebooted = new Store(path);
    assert.equal(rebooted.getPet(fresh.id)?.openedAt, null, 'the operator’s unopened egg survives a restart');
    rebooted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing the vivarium releases the collection and starts the beats from zero', () => {
  const { store, pets } = timedKeeper({ dropChance: 1 });
  for (let i = 0; i < 3; i++) answer(store, `question ${i}`);
  pets.scan();
  spend(store, 1);
  const [first] = store.listPets();
  assert.ok(first);
  assert.equal(pets.open(first.id).ok, true);
  assert.equal(pets.feed(first.id, 25).ok, true, 'a dollar of spend buys 25 beats');

  const reset = pets.resetOnce();
  assert.equal(reset?.cleared, 3, 'it reports what it released');
  assert.deepEqual(store.listPets(), [], 'and the collection is gone');
  assert.deepEqual(pets.state()?.wallet, { earned: 0, spent: 0, balance: 0 }, 'beats start again from zero');
});

test('a cleared collection does not hatch back out of the history it came from', () => {
  const { store, pets } = timedKeeper({ dropChance: 1 });
  for (let i = 0; i < 3; i++) answer(store, `question ${i}`);
  pets.scan();
  pets.resetOnce();

  assert.deepEqual(pets.scan(), [], 'the actions are still rolled, so nothing is rolled again');
  assert.deepEqual(store.listPets(), []);

  answer(store, 'something new');
  assert.equal(pets.scan().length, 1, 'a fresh action hatches into the cleared enclosure');
});

test('a clearance runs once, and never takes what hatched after it', () => {
  const { store, pets } = timedKeeper({ dropChance: 1 });
  answer(store, 'before');
  pets.scan();
  assert.equal(pets.resetOnce()?.cleared, 1);

  answer(store, 'after');
  pets.scan();
  assert.equal(pets.resetOnce(), null, 'the stamp is what makes every later boot a no-op');
  assert.equal(store.listPets().length, 1, 'and the pet that hatched after it stays');
});

test('the beats a cleared vivarium earns are the spend since it was cleared', () => {
  const { store, pets } = timedKeeper({ dropChance: 1 });
  answer(store, 'hatch me something');
  pets.scan();
  spend(store, 4);
  assert.equal(pets.state()?.wallet.earned, 100);

  pets.resetOnce();
  assert.equal(pets.state()?.wallet.earned, 0, 'spend from before the clearance buys nothing after it');
  spend(store, 2);
  assert.equal(pets.state()?.wallet.earned, 50, 'and what the fleet spends afterwards does');
});

test('a clearance is skipped entirely while pets are turned off', () => {
  const { store, pets } = timedKeeper({ dropChance: 1 });
  answer(store, 'hatch me something');
  pets.scan();

  const off = new PetKeeper(store, { enabled: false, visible: true });
  assert.equal(off.resetOnce(), null);
  assert.equal(store.listPets().length, 1, 'off has never deleted anything, and this is not the change that does');
  assert.equal(pets.resetOnce()?.cleared, 1);
});

test('no configuration key can reach the roll', () => {
  const fields = readFileSync('src/configFields.ts', 'utf8');
  const paths = [...fields.matchAll(/path: '(pets\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    paths,
    ['pets.enabled', 'pets.visible'],
    'the only pets keys an operator may set are the two switches',
  );

  const policy = readFileSync('src/pets/keeper.ts', 'utf8');
  const shape = /export interface PetPolicy \{([^}]*)\}/.exec(policy)?.[1] ?? '';
  assert.deepEqual(
    shape
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    ['enabled: boolean;', 'visible: boolean;'],
    'PetPolicy holds the two switches and nothing that is a number',
  );
});

test('an action reaches one species per tier, and never the one you wanted', () => {
  for (const kind of KINDS) {
    const reach = speciesCandidates(kind, 'ref_c0ffee', '2026-04-12T14:00:00.000Z');
    assert.equal(reach.size, 4, `${kind} must reach one species per tier, saw ${reach.size}`);
    assert.ok(reach.size < Object.keys(SPECIES).length, 'and never the whole catalogue');
  }
  for (const kind of KINDS)
    if (kind !== 'upgrade')
      assert.ok(
        !speciesCandidates(kind, 'ref_c0ffee', '2026-04-12T14:00:00.000Z').has('ouroboros'),
        `${kind} must not be a route to another action's mythic`,
      );
});

test('a pet the scan hatched checks out, and one written straight into the table does not', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'a question really answered');
  const [real] = pets.scan();
  assert.ok(real);
  assert.equal(attestPet(real, ledger(store)), null, 'what the scan wrote must verify against what the scan recorded');

  const forged = store.hatchPet({
    species: 'ouroboros',
    seed: 'upgrade:deadbeef',
    originKind: 'upgrade',
    originRef: 'deadbeef',
    hatchedAt: '2026-04-12T14:00:00.000Z',
  });
  assert.equal(attestPet(forged, ledger(store))?.code, 'unrecorded', 'nothing rolled it, so nothing accounts for it');
});

test('a forged pet cannot be laundered back into beats', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'a question really answered');
  pets.scan();
  const at = '2026-04-12T14:00:00.000Z';
  const forged = store.hatchPet({
    species: 'ouroboros',
    seed: 'escalation:esc_forged',
    originKind: 'escalation',
    originRef: 'esc_forged',
    hatchedAt: at,
  });
  store.recordPetAction({ kind: 'escalation', ref: 'esc_forged', at, petId: forged.id });
  assert.equal(attestPet(forged, ledger(store))?.code, 'impossible', 'no escalation can ever roll the mythic');

  const blended = pets.blend(forged.id);
  assert.equal(blended.ok, false);
  assert.match(blended.ok ? '' : blended.error, /does not check out/, 'refused for what it is, not for being the last');
  assert.equal(store.getPet(forged.id)?.dissolvedAt, null, 'and not dissolved — nothing here deletes anything');
  assert.equal(pets.feed(forged.id, 1).ok, false, 'nor fed');
  assert.equal(pets.place(forged.id, true).ok, false, 'nor put out');
});

test('a hand-grown pet is caught by what nothing paid for', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'a question really answered');
  const [pet] = pets.scan();
  assert.ok(pet);
  const grown: Pet = { ...pet, fed: 99_999 };
  assert.equal(attestPet(grown, ledger(store))?.code, 'overfed', 'a stage nothing bought is a stage nobody earned');
});

test('a flaw is drawn, never deleted, and the origin line survives it', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'a question really answered');
  pets.scan();
  const forged = store.hatchPet({
    species: 'ouroboros',
    seed: 'upgrade:deadbeef',
    originKind: 'upgrade',
    originRef: 'deadbeef',
    hatchedAt: '2026-04-12T02:00:00.000Z',
  });

  const state = pets.state();
  const drawn = state?.pets.find((p) => p.id === forged.id);
  assert.ok(drawn, 'it is still on the shelf');
  assert.ok(drawn.flaw !== null, 'and marked');
  assert.ok(drawn.flaw.note.length > 0, 'with a sentence an operator can act on');
  assert.equal(drawn.originRef, 'deadbeef', 'keeping the origin line, which is the point of the panel');
  assert.equal(state?.pets.filter((p) => p.flaw === null).length, 1, 'the earned one is untouched beside it');
});

test('every pet a long ordinary run produces verifies', () => {
  const { store, pets } = keeper();
  for (let i = 0; i < 60; i++) {
    answer(store, `question ${i}`);
    settle(store, `task ${i}`);
  }
  pets.scan();
  const all = store.listPets();
  assert.ok(all.length > 0, 'a hundred and twenty actions must produce something to check');
  for (const pet of all) assert.equal(attestPet(pet, ledger(store)), null, `${pet.species} from ${pet.originRef}`);
});

test('a pet records the build that rolled it', () => {
  const { store, pets } = keeper({ dropChance: 1 }, { sha: 'build_one', clean: false });
  answer(store, 'hatched by a modified build');
  const [pet] = pets.scan();
  assert.ok(pet);
  assert.equal(pet.builtSha, 'build_one');
  assert.equal(pet.builtClean, false, 'the checkout carried edits, and the row says so');
  assert.equal(pets.state()?.pets[0]?.provenance, 'modified');
});

test('the replay accuses only what this same clean build hatched', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'a real one');
  pets.scan();
  const at = new Date(Date.parse(started(store)) + 60_000).toISOString();

  store.recordPetAction({ kind: 'escalation', ref: 'esc_barren', at, petId: null });
  const log = store.petActionLog();
  const barren = replayBarren(log, PET_RULES, started(store));
  assert.ok(barren.has('escalation:esc_barren'), 'at the shipped chance, this one hatches nothing');

  const plausible = [...speciesCandidates('escalation', 'esc_barren', at)][0]!;
  for (const [claim, expected] of [
    [{ sha: 'build_one', clean: true }, 'unearned'],
    [{ sha: 'build_two', clean: true }, undefined],
    [{ sha: 'build_one', clean: false }, undefined],
    [{ sha: null, clean: false }, undefined],
  ] as const) {
    const forged: Pet = {
      id: 'pet_forged',
      species: plausible,
      seed: 'escalation:esc_barren',
      name: null,
      fed: 0,
      originKind: 'escalation',
      originRef: 'esc_barren',
      hatchedAt: at,
      openedAt: at,
      placed: false,
      dissolvedAt: null,
      builtSha: claim.sha,
      builtClean: claim.clean,
      chain: null,
    };
    const seen = { ...ledger(store), actions: new Map(store.petActionIndex()) };
    seen.actions.set('escalation:esc_barren', { at, petId: 'pet_forged' });
    assert.equal(
      attestPet(forged, seen)?.code,
      expected,
      `a pet claiming ${claim.sha ?? 'no build'}${claim.clean ? ' clean' : ' modified'}`,
    );
  }
});

test('an edit anywhere in the collection breaks the chain from there on', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  for (let i = 0; i < 4; i++) answer(store, `question ${i}`);
  pets.scan();
  const chain = replayChain(store.petChainLog());
  for (const pet of store.listPets()) assert.equal(pet.chain, chain.get(pet.id), 'what was written is what recomputes');

  const log = store.petChainLog();
  const victim = log[1]!;
  const edited = log.map((row) =>
    row.id === victim.id ? { ...row, link: { ...row.link, species: 'ouroboros' as const } } : row,
  );
  const after = replayChain(edited);
  assert.notEqual(after.get(victim.id), chain.get(victim.id), 'its own link moves');
  assert.notEqual(after.get(log[3]!.id), chain.get(log[3]!.id), 'and so does every link behind it');
});

test('a broken link is a flaw, and a missing one is not an accusation', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'a real one');
  const [pet] = pets.scan();
  assert.ok(pet);

  const tampered: Pet = { ...pet, chain: 'not the link this row should carry' };
  assert.equal(attestPet(tampered, ledger(store))?.code, 'broken-chain');

  const historical: Pet = { ...pet, chain: null };
  assert.equal(attestPet(historical, ledger(store)), null, 'no link is not a broken link');
});

test('a database from before the stamp reads as unknown rather than as suspect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pets-stamp-'));
  const file = join(dir, 'before-stamps.sqlite');
  try {
    const old = new Database(file);
    old.exec(`CREATE TABLE pets (
      id TEXT PRIMARY KEY, species TEXT NOT NULL, seed TEXT NOT NULL, name TEXT,
      fed INTEGER NOT NULL DEFAULT 0, origin_kind TEXT NOT NULL, origin_ref TEXT NOT NULL,
      hatched_at TEXT NOT NULL, placed INTEGER NOT NULL DEFAULT 0, dissolved_at TEXT,
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
    assert.equal(pet.builtSha, null, 'with no build recorded');
    assert.equal(pet.builtClean, false);
    assert.equal(pet.chain, null, 'and no link');
    assert.equal(provenanceOf(pet), 'unknown', 'which is a shrug, not a suspicion');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database from before blending gains the column rather than reading undefined', () => {
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
  for (const dir of ['src/dispatcher', 'src/mcp', 'docs/prompt-templates']) {
    for (const file of allFiles(dir)) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      assert.ok(!text.includes('vivarium'), `${file} must not mention the vivarium to an agent`);
    }
  }
});

test('the roll never reaches for randomness', () => {
  for (const file of srcFiles('src/pets')) {
    assert.ok(
      !stripComments(readFileSync(file, 'utf8')).includes('Math.random'),
      `${file} must stay deterministic — a random roll turns every re-read into a fresh chance at a pet`,
    );
  }
});

test('the state carries the vivarium’s start, so the cockpit can say why a backlog paid nothing', () => {
  const { store, pets } = coldKeeper({ dropChance: 1 });
  assert.equal(
    pets.state()?.startedAt,
    null,
    'before the first scan there is no start, and a surface draws nothing rather than a placeholder',
  );
  assert.equal(store.vivariumStart(), null, 'drawing the cockpit does not start the vivarium');

  answer(store, 'hatch me something');
  pets.scan();
  assert.equal(pets.state()?.startedAt, store.vivariumStart(), 'and afterwards it is the store’s own start');
});

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...allFiles(path));
    else out.push(path);
  }
  return out.sort();
}

function oneOfEachKind(store: Store): Map<PetActionKind, string> {
  const refs = new Map<PetActionKind, string>();
  refs.set('escalation', answer(store, 'Should the rate-limit park apply to review agents too?'));
  refs.set('human-task', settle(store, 'Issue a deploy key for the staging cluster'));
  const plan = store.upsertPlan({ originRef: 'issue:437', title: 'Give jobs real names', status: 'active' });
  refs.set('plan', plan.id);
  refs.set('landing', store.recordStackLanding('stack:413', [411, 412]).id);
  refs.set('job', store.createJob({ title: 'Re-run the flaky worktree suite', prompt: 'go', kind: 'code' }).id);
  store.writeUpgradeIntent({
    state: 'applying',
    targetSha: '9c1d4a2f6b3e',
    requestedAt: new Date().toISOString(),
    pausedByDrain: false,
  });
  refs.set('upgrade', '9c1d4a2f6b3e');
  return refs;
}

test('every origin arrives on the wire as words rather than as a row id', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  const refs = oneOfEachKind(store);
  pets.scan();
  const state = pets.state();
  assert.ok(state);
  const byKind = new Map(state.pets.map((pet) => [pet.originKind, pet]));
  for (const kind of LIVE_KINDS) assert.ok(byKind.has(kind), `${kind} must have hatched something to label`);
  assert.equal(byKind.get('escalation')?.originLabel, 'Should the rate-limit park apply to review agents too?');
  assert.equal(byKind.get('human-task')?.originLabel, 'Issue a deploy key for the staging cluster');
  assert.equal(byKind.get('plan')?.originLabel, 'Give jobs real names');
  assert.equal(byKind.get('landing')?.originLabel, 'stack:413');
  assert.equal(byKind.get('job')?.originLabel, 'Re-run the flaky worktree suite');
  assert.equal(byKind.get('upgrade')?.originLabel, '9c1d4a2');
  for (const kind of LIVE_KINDS) assert.equal(byKind.get(kind)?.originRef, refs.get(kind));
});

test('the labels are one batched read per kind over the refs the vivarium holds', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  oneOfEachKind(store);
  answer(store, 'a second question');
  pets.scan();

  const asked = new Map<string, string[][]>();
  const methods = ['escalationLabels', 'humanTaskLabels', 'planLabels', 'landingLabels', 'jobLabels'] as const;
  for (const method of methods) {
    const real = store[method].bind(store);
    store[method] = (ids: string[]): Map<string, string> => {
      asked.set(method, [...(asked.get(method) ?? []), ids]);
      return real(ids);
    };
  }

  const state = pets.state();
  assert.ok(state);
  for (const method of methods) {
    assert.deepEqual(
      asked.get(method)?.length,
      1,
      `${method} must be asked once for the whole grid, not once per card`,
    );
  }
  const escalations = state.pets.filter((pet) => pet.originKind === 'escalation');
  assert.equal(escalations.length, 2, 'the second escalation must have hatched, or this asserts nothing');
  assert.deepEqual(
    [...(asked.get('escalationLabels')?.[0] ?? [])].sort(),
    escalations.map((pet) => pet.originRef).sort(),
    'each kind is asked for exactly the refs its pets carry — never for the table',
  );
});

test('a label with a paragraph in it arrives clamped to one line', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, `  Two rooms,\n\nand a corridor between them.  \t ${'long '.repeat(40)}`);
  pets.scan();
  const state = pets.state();
  const label = state?.pets[0]?.originLabel ?? '';
  assert.ok(!label.includes('\n'), 'a newline in a label reflows the grid');
  assert.ok(label.length <= 90, `a label must fit a card, got ${label.length}`);
  assert.ok(label.startsWith('Two rooms, and a corridor between them.'), `unexpected clamp: ${label}`);
  assert.ok(label.endsWith('…'), 'a clamped label says that it was clamped');
});

test('a source row that has gone leaves no label, and is not an accusation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pets-label-'));
  const path = join(dir, 'labels.sqlite');
  try {
    const store = new Store(path);
    const pets = new PetKeeper(store, { enabled: true, visible: true }, rules({ dropChance: 1 }), () => BUILD);
    pets.scan();
    const id = answer(store, 'a question somebody later pruned');
    pets.scan();
    assert.equal(pets.state()?.pets[0]?.originLabel, 'a question somebody later pruned');
    store.close();

    const raw = new Database(path);
    raw.prepare(`DELETE FROM escalations WHERE id=?`).run(id);
    raw.close();

    const after = new Store(path);
    const reopened = new PetKeeper(after, { enabled: true, visible: true }, rules({ dropChance: 1 }), () => BUILD);
    const pet = reopened.state()?.pets[0];
    assert.equal(pet?.originLabel, null, 'a missing row is no label');
    assert.equal(pet?.originRef, id, 'and the card still has the ref it always drew');
    assert.equal(pet?.flaw, null, 'a pruned source must never read as a forgery');
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a vivarium raised before the chain keeps the pets it earns afterwards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-pets-chain-'));
  const file = join(dir, 'before-chain.sqlite');
  try {
    const first = new Store(file);
    const early = new PetKeeper(first, { enabled: true, visible: true }, rules({ dropChance: 1 }), () => BUILD);
    early.scan();
    answer(first, 'the one that predates the column');
    const [old] = early.scan();
    assert.ok(old, 'the fixture starts from a pet the harness itself rolled');
    first.close();

    const raw = new Database(file);
    raw.exec(`CREATE TABLE pets_pre AS SELECT id, species, seed, name, fed, origin_kind, origin_ref,
                hatched_at, opened_at, placed, dissolved_at, built_sha, built_clean FROM pets;
              DROP TABLE pets;
              ALTER TABLE pets_pre RENAME TO pets;`);
    raw.close();

    const store = new Store(file);
    assert.equal(store.getPet(old.id)?.chain, null, 'the historical row carries no link, as designed');
    const pets = new PetKeeper(store, { enabled: true, visible: true }, rules({ dropChance: 1 }), () => BUILD);
    for (let i = 0; i < 4; i++) answer(store, `earned after the upgrade ${i}`);
    const fresh = pets.scan();
    assert.equal(fresh.length, 4, 'the vivarium still hatches');

    const book: PetLedger = {
      ...ledger(store),
      barren: replayBarren(store.petActionLog(), rules({ dropChance: 1 }), started(store)),
    };
    assert.equal(attestPet(store.getPet(old.id)!, book), null, 'a pet from before the chain is not judged');
    for (const pet of fresh) {
      assert.equal(attestPet(pet, book), null, `${pet.id} was earned honestly and must not read as an insertion`);
    }
    const log = store.petChainLog();
    const victim = log[2]!;
    const tampered = log.map((row) =>
      row.id === victim.id ? { ...row, link: { ...row.link, species: 'ouroboros' as const } } : row,
    );
    const after = replayChain(tampered);
    assert.notEqual(after.get(log[log.length - 1]!.id), book.chain.get(log[log.length - 1]!.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
