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

/**
 * The rates, with whatever this test needs bent. Nothing threads this from config.
 *
 * `dropChance` and `pity` are per action kind on `PET_RULES`, and a test that says
 * `{ dropChance: 1 }` means it of every kind — so they are accepted flat here and
 * spread across the whole table. A test that needs one kind bent and the rest left
 * alone passes `rates` instead.
 */
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

/** A keeper over a database whose vivarium has not started yet. */
function coldKeeper(over: RuleOverrides = {}, build = BUILD): { store: Store; pets: PetKeeper } {
  const store = new Store(':memory:');
  return { store, pets: new PetKeeper(store, { enabled: true, visible: true }, rules(over), () => build) };
}

function keeper(over: RuleOverrides = {}, build = BUILD): { store: Store; pets: PetKeeper } {
  const { store, pets } = coldKeeper(over, build);
  // The boot before the operator does anything: it hatches nothing and stamps the
  // vivarium's start, so the actions a test goes on to make fall *after* it. A
  // deployment reaches this scan the same way — `main.ts` runs one at boot — and a
  // test that skipped it would be manufacturing a backlog and then asking why it
  // paid nothing.
  pets.scan();
  return { store, pets };
}

/** The build the suite pretends to be running, so a stamp does not need a checkout. */
const BUILD = { sha: 'build_one', clean: true };

/** What the keeper checks a pet against, read straight out of the store. */
function ledger(store: Store, build = BUILD): PetLedger {
  return {
    actions: store.petActionIndex(),
    paid: store.petPaidTotals(),
    chain: replayChain(store.petChainLog()),
    barren: replayBarren(store.petActionLog(), PET_RULES, started(store)),
    build,
  };
}

/** When this store's vivarium started counting, which the boundary-aware reads take. */
function started(store: Store): string {
  const at = store.vivariumStart();
  assert.ok(at !== null, 'a scan stamps the start, and every keeper here has scanned');
  return at;
}

/** Every action that can roll, which several tests walk. */
const KINDS: PetActionKind[] = ['escalation', 'human-task', 'plan', 'landing', 'job', 'claim', 'upgrade'];

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
  // The deployment's first action always hatches, so the miss under test is the second.
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
  // The first action ever, then three that would all miss — the third is forced.
  for (let i = 0; i < 4; i++) answer(store, `question ${i}`);
  const hatched = pets.scan();
  assert.equal(hatched.length, 2, 'the first action ever, and then the one pity forces');
  // Sparse by design: the last escalation row hatched, so nothing sits after it
  // and the kind has no row of its own. Absent is how zero is spelled.
  assert.equal(
    store.petActionsSinceHatch(started(store)).get('escalation') ?? 0,
    0,
    'and the counter resets behind it',
  );
});

test('pity is counted per kind, so a busy action cannot spend a quiet one’s floor', () => {
  // The whole of why the counter went per kind. A deployment settles jobs and
  // findings by the dozen and accepts an upgrade a few times a year, so one shared
  // counter is spent almost entirely by whatever is most frequent — pity then
  // fires constantly on the busy action and never on the quiet one, which is the
  // opposite of what a floor is for.
  const { store, pets } = keeper({ dropChance: 0, pity: 3 });
  answer(store, 'the first action ever, which is guaranteed');
  pets.scan();

  // Two escalations short of escalation's own ceiling, and a run of tasks between
  // them. A shared counter would be forced by the tasks alone.
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
  // The rate is priced against how often the kind comes up. Without that, a
  // collection is drawn almost entirely from whichever button the deployment
  // presses most, and the animals behind the scarce actions are never seen.
  const { rates } = PET_RULES;
  assert.ok(rates.upgrade.dropChance > rates.landing.dropChance, 'an upgrade is scarcer than a landing');
  assert.ok(rates.landing.dropChance > rates.plan.dropChance, 'a landing is scarcer than a plan');
  assert.ok(rates.plan.dropChance > rates['human-task'].dropChance, 'a plan is scarcer than a task');
  assert.ok(rates['human-task'].dropChance > rates.finding.dropChance, 'a task is scarcer than a finding');
  assert.ok(rates.finding.dropChance > rates.job.dropChance, 'and a finding is scarcer than a job launch');

  // Pity stays a ceiling rather than a schedule: twice the expected gap, per kind.
  for (const kind of KINDS)
    assert.ok(
      Math.abs(rates[kind].pity - 2 / rates[kind].dropChance) <= 4,
      `${kind} pity must be about twice its own expected gap, saw ${rates[kind].pity}`,
    );
});

test('every action is a route to a mythic, and each mythic to one action', () => {
  // The complaint this answers: `upgrade` held the only mythic in the catalogue,
  // at 2% of the hatches of an action a deployment takes a handful of times a
  // year — roughly one in twenty-five hundred accepted self-updates, which is an
  // animal nobody ever sees. A mythic per action makes the tier reachable; one
  // action per mythic keeps each of them worth having.
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

// -- Where the vivarium starts -----------------------------------------------

/**
 * The boundary a replay used before this one existed: earlier than any timestamp
 * the harness can hold, so every row in the log passes it. What "the same answer
 * as before the boundary" is asserted against.
 */
const BEFORE_EVERYTHING = '0000-01-01T00:00:00.000Z';

test('a backlog from before the vivarium started is recorded, and pays for nothing', () => {
  // The deployment the report came from: months of history, pets switched on for
  // the first time, and a scan that read the lot as this afternoon's work.
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
  // The risk worth a test of its own: a start computed one row too late marks an
  // honestly earned action pre-boundary, which moves the pity walk and `firstEver`
  // in the replay and puts an `unearned` badge on somebody’s real animal, on the
  // boot they take the build.
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

    // A database from before this change holds no start at all. Every reader of
    // one has to survive that, and the value the first boot writes is the whole of
    // whether an existing collection comes through it untouched.
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
  // The same beats leave a mythic further back, which is what makes it feel rare.
  assert.equal(petStage('ouroboros', 8_000), 'juvenile');
  assert.equal(beatsToNextStage('pip', 8_000), null, 'an adult owes nothing');
});

test('beats are derived from spend, and feeding refuses more than there is', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'hatch me something');
  const [pet] = pets.scan();
  assert.ok(pet);
  // A drop arrives as an egg, and an egg is not fed — the shell comes off first.
  assert.equal(pets.open(pet.id).ok, true);

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

  const off = new PetKeeper(store, { enabled: false, visible: true });
  assert.deepEqual(off.scan(), []);
  assert.equal(off.state(), null, 'the cockpit draws nothing rather than an empty enclosure');
  assert.equal(off.feed('anything', 1).ok, false);
  assert.equal(store.listPets().length, 1, 'and what hatched is still there');
});

test('hiding pets draws nothing and stops nothing', () => {
  // The whole of what separates hidden from off: an operator who does not want
  // animals on their cockpit is not also deciding that the months of work they do
  // while it is off were worth nothing. Turning it back on shows what accrued.
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
      rules: rules({ dropChance: 1 }),
      forced: false,
      firstEver: false,
    });
    counts[SPECIES[roll.species].rarity] = (counts[SPECIES[roll.species].rarity] ?? 0) + 1;
  }
  // Every pool now fills every tier, so nothing degrades and the weights land as
  // written: the shipped table read straight off an action.
  assert.ok(Math.abs(counts.common! / 4_000 - 0.7) < 0.05, `common should sit near 70%, saw ${counts.common}/4000`);
  assert.ok(
    Math.abs(counts.uncommon! / 4_000 - 0.2) < 0.05,
    `uncommon should sit near 20%, saw ${counts.uncommon}/4000`,
  );
  assert.ok(Math.abs(counts.rare! / 4_000 - 0.08) < 0.03, `rare should sit near 8%, saw ${counts.rare}/4000`);
  assert.ok(Math.abs(counts.mythic! / 4_000 - 0.02) < 0.02, `mythic should sit near 2%, saw ${counts.mythic}/4000`);
});

test('every action carries a full ladder, so no shipped roll degrades', () => {
  // `upgrade` used to hold the only mythic and `human-task` and `job` no rare at
  // all, so a tier those pools could not fill degraded away — which put the
  // scarcest animals behind the scarcest action and made them, in practice,
  // unreachable. A hole in a pool is now a bug rather than a way of expressing a
  // ceiling; the ceiling is the rate, where it can be read as a number.
  for (const kind of KINDS)
    for (const tier of ['common', 'uncommon', 'rare', 'mythic'] as const)
      assert.equal(resolveTier(kind, tier, 14)?.tier, tier, `${kind} must fill ${tier} itself, not by degrading`);
});

test('degrading still walks downward, never up', () => {
  // No shipped pool degrades any more, so this is a guard rather than a mechanic
  // — but the direction stays the invariant it always was: reaching *up* would
  // make the scarcest actions the easiest source of the scarcest animals.
  // Exercised through the night gate, the one filter that can empty a tier.
  const gated = resolveTier('escalation', 'uncommon', 14);
  assert.ok(gated !== null && !gated.members.includes('nocturne'), 'the day filter drops nocturne');
  assert.equal(gated.tier, 'uncommon', 'and what is left still fills the tier');
});

test('pity forces the hatch and never touches the tier', () => {
  // A pet you were given because you had been unlucky must be exactly as likely
  // to be a mythic as one the roll granted: paying out worse would make pity a
  // punishment, better would make waiting the strategy.
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
  // One common per pool put `pip` at 70% of hatches on five of the seven actions.
  // Three per pool is what keeps any single animal near a fifth.
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

  // And once something *is* dissolved it stops being a live pet in every sense.
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

// -- Clearing the vivarium ---------------------------------------------------

/** A keeper on a clock that moves a minute per read, so an epoch can be compared. */
function coldTimedKeeper(over: RuleOverrides = {}): { store: Store; pets: PetKeeper } {
  let tick = 0;
  const store = new Store(':memory:', () =>
    new Date(Date.parse('2026-04-12T09:00:00.000Z') + tick++ * 60_000).toISOString(),
  );
  return { store, pets: new PetKeeper(store, { enabled: true, visible: true }, rules(over), () => BUILD) };
}

function timedKeeper(over: RuleOverrides = {}): { store: Store; pets: PetKeeper } {
  const { store, pets } = coldTimedKeeper(over);
  pets.scan(); // The boot before the operator acts — see `keeper`.
  return { store, pets };
}

/** One dollar of fleet spend, which is 25 beats at the shipped rate. */
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

  // The point of the whole design: the click reveals what the hash already
  // settled. A roll here would put the subsystem's one decision behind a click,
  // and a re-scan would stop being free.
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

  // Putting one out is the one act an egg has, and it is the point of an egg: the
  // corner of the rail is where you find it. A slot is freed first — twelve drops
  // fill the enclosure, and a full one is refused for being full, not for holding
  // a shell.
  const standing = store.listPets().find((p) => p.placed)!;
  assert.equal(pets.place(standing.id, false).ok, true);
  assert.equal(pets.place(egg.id, true).ok, true);
});

test('a vivarium from before eggs is not turned back into a crate of shells', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-eggs-'));
  const path = join(dir, 'old.db');
  try {
    // The `pets` table exactly as a build from before the shell wrote it — no
    // `opened_at` at all, which is the state every deployment upgrades from.
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

    // And the backfill is a one-off, not a boot chore: an egg laid after the
    // upgrade is still an egg on the next restart.
    const pets = new PetKeeper(store, { enabled: true, visible: true }, rules({ dropChance: 1 }), () => BUILD);
    pets.scan(); // The boot, which stamps the vivarium's start before the operator acts.
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

  // The vivarium is empty, not dead: the next thing the operator does still lands.
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
  // Turned on later, the deployment still gets its clearance.
  assert.equal(pets.resetOnce()?.cleared, 1);
});

// -- Authenticity ------------------------------------------------------------

test('no configuration key can reach the roll', () => {
  // The cheapest forgery there was: `dropChance: 1` and a rarity table zeroed
  // everywhere but `mythic` hatches a full vivarium out of one config edit, and
  // every animal in it arrives through the ordinary scan with a real origin line.
  // Nothing on any surface can tell that from an earned one, which is why the
  // rates are constants and this test is structural rather than behavioural.
  const fields = readFileSync('src/configFields.ts', 'utf8');
  const paths = [...fields.matchAll(/path: '(pets\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    paths,
    ['pets.enabled', 'pets.visible'],
    'the only pets keys an operator may set are the two switches',
  );

  // And the type says so too, so a key added to the page has nowhere to land.
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
  // The load-bearing property behind the whole check: stage 3 is a hash of the
  // action's own key, so a forger cannot pick the animal — they have to grind for
  // an origin ref that happens to give it, and the ref has to belong to something
  // really settled.
  for (const kind of KINDS) {
    const reach = speciesCandidates(kind, 'ref_c0ffee', '2026-04-12T14:00:00.000Z');
    // One per tier, and the tiers hold disjoint members. Filling every ladder
    // widened this from the two or three a holey pool reached; four in
    // twenty-seven is still narrower than three in twenty was.
    assert.equal(reach.size, 4, `${kind} must reach one species per tier, saw ${reach.size}`);
    assert.ok(reach.size < Object.keys(SPECIES).length, 'and never the whole catalogue');
  }
  // Each mythic belongs to exactly one action, so no other kind is a route to it.
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

  // The cheap forgery: a row in `pets` and nothing else.
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
  // Blending is the only route from a creature back into food, so it is the one
  // refusal that costs an attacker something rather than only themselves. The
  // forgery here is the *careful* one: a `pet_actions` row written to match, so
  // only the species gives it away.
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
  // `fed` is a cache of the purchases beside it, so a column edited to put a
  // creature two stages along has nothing backing it.
  const grown: Pet = { ...pet, fed: 99_999 };
  assert.equal(attestPet(grown, ledger(store))?.code, 'overfed', 'a stage nothing bought is a stage nobody earned');
});

test('a flaw is drawn, never deleted, and the origin line survives it', () => {
  // The rule the whole subsystem is built on: nothing is taken away. A pet that
  // does not verify keeps its row, its species and the night it claims — it simply
  // stops being feedable, placeable and blendable, and says why on its card.
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
  // The failure that would matter most is a false positive: an honest operator
  // told their collection is a forgery. Two kinds of action, a hundred rolls, and
  // pity firing throughout — everything the scan writes must check out.
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
  // Taking the rates out of the config stops the config route to a free vivarium
  // and stops nothing for somebody editing `src/pets/rules.ts` and restarting.
  // The stamp is what makes that visible.
  const { store, pets } = keeper({ dropChance: 1 }, { sha: 'build_one', clean: false });
  answer(store, 'hatched by a modified build');
  const [pet] = pets.scan();
  assert.ok(pet);
  assert.equal(pet.builtSha, 'build_one');
  assert.equal(pet.builtClean, false, 'the checkout carried edits, and the row says so');
  assert.equal(pets.state()?.pets[0]?.provenance, 'modified');
});

test('the replay accuses only what this same clean build hatched', () => {
  // The failure worth avoiding above all others: telling an honest operator their
  // collection is fake, on their machine, months later. A pet decided by constants
  // this process does not hold is a pet this process may not judge.
  const { store, pets } = keeper({ dropChance: 1 });
  answer(store, 'a real one');
  pets.scan();
  // After the vivarium started, or the replay skips it as a backlog row and the
  // check under test never runs.
  const at = new Date(Date.parse(started(store)) + 60_000).toISOString();

  // An action the shipped rules would have hatched nothing on, with a pet against
  // it anyway — which is what editing the drop chance and restarting looks like.
  store.recordPetAction({ kind: 'escalation', ref: 'esc_barren', at, petId: null });
  const log = store.petActionLog();
  const barren = replayBarren(log, PET_RULES, started(store));
  assert.ok(barren.has('escalation:esc_barren'), 'at the shipped chance, this one hatches nothing');

  // A species that origin really can roll, so the earlier checks pass and the
  // replay is what is under test.
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

  // Re-species the second one written, as a hand edit would.
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

  // A pet from before the chain existed carries no link at all, and every check
  // that could accuse it declines instead — the whole migration rests on this.
  const historical: Pet = { ...pet, chain: null };
  assert.equal(attestPet(historical, ledger(store)), null, 'no link is not a broken link');
});

test('a database from before the stamp reads as unknown rather than as suspect', () => {
  // Built against the *old* shape on purpose: a fresh database gets the columns
  // from `SCHEMA` and would pass without the migration existing.
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

test('the state carries the vivarium’s start, so the cockpit can say why a backlog paid nothing', () => {
  const { store, pets } = coldKeeper({ dropChance: 1 });
  assert.equal(
    pets.state()?.startedAt,
    null,
    'before the first scan there is no start, and a surface draws nothing rather than a placeholder',
  );
  // Read, never stamped: `state()` runs on every heartbeat, and a read that wrote
  // the boundary would start the vivarium on whichever pulse first drew the
  // cockpit rather than on the first scan that could hatch anything.
  assert.equal(store.vivariumStart(), null, 'drawing the cockpit does not start the vivarium');

  answer(store, 'hatch me something');
  pets.scan();
  assert.equal(pets.state()?.startedAt, store.vivariumStart(), 'and afterwards it is the store’s own start');
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

// ---------------------------------------------------------------------------
// The origin label (`docs/spec/22-pets.md#the-sources`)
// ---------------------------------------------------------------------------

/** One settled action of every kind, so a scan can hatch a pet from each. */
function oneOfEachKind(store: Store): Map<PetActionKind, string> {
  const refs = new Map<PetActionKind, string>();
  refs.set('escalation', answer(store, 'Should the rate-limit park apply to review agents too?'));
  refs.set('human-task', settle(store, 'Issue a deploy key for the staging cluster'));
  const plan = store.upsertPlan({ originRef: 'issue:437', title: 'Give jobs real names', status: 'active' });
  refs.set('plan', plan.id);
  refs.set('landing', store.recordStackLanding('stack:413', [411, 412]).id);
  refs.set('job', store.createJob({ title: 'Re-run the flaky worktree suite', prompt: 'go', kind: 'code' }).id);
  const raised = store.proposeFact(
    {
      claim: 'ingest.ts buffers the whole body',
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'A 400MB upload took the process down.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: 'agent_1', taskId: 'task_1', goalRef: null, sessionId: null, words: 'saw it' },
  );
  assert.ok(raised.outcome !== 'barred');
  // Ruling on it is the operator action — `ruledAt` is the one stamp that means
  // exactly that, which is why the scan reads it rather than the reach.
  store.setFactReach(raised.fact.id, 'rejected');
  refs.set('claim', raised.fact.id);
  // Stamped now, not at a fixed date. Every other action here takes its timestamp
  // from the store's clock, and `requestedAt` is the one a caller supplies — so a
  // literal puts this action before the vivarium's start, where it is recorded
  // inert and hatches nothing.
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
  for (const kind of KINDS) assert.ok(byKind.has(kind), `${kind} must have hatched something to label`);
  assert.equal(byKind.get('escalation')?.originLabel, 'Should the rate-limit park apply to review agents too?');
  assert.equal(byKind.get('human-task')?.originLabel, 'Issue a deploy key for the staging cluster');
  assert.equal(byKind.get('plan')?.originLabel, 'Give jobs real names');
  assert.equal(byKind.get('landing')?.originLabel, 'stack:413');
  assert.equal(byKind.get('job')?.originLabel, 'Re-run the flaky worktree suite');
  assert.equal(byKind.get('claim')?.originLabel, 'ingest.ts buffers the whole body');
  // An upgrade is the one kind that reads nothing: its ref is the commit itself.
  assert.equal(byKind.get('upgrade')?.originLabel, '9c1d4a2');
  // And the ref the label stands beside has not moved — it is the seed, the
  // re-roll's input and part of the chain hash.
  for (const kind of KINDS) assert.equal(byKind.get(kind)?.originRef, refs.get(kind));
});

test('the labels are one batched read per kind over the refs the vivarium holds', () => {
  const { store, pets } = keeper({ dropChance: 1 });
  oneOfEachKind(store);
  // A second escalation, so "the refs it holds" is more than one and a query per
  // card would show up as two calls rather than one.
  answer(store, 'a second question');
  pets.scan();

  const asked = new Map<string, string[][]>();
  const methods = [
    'escalationLabels',
    'humanTaskLabels',
    'planLabels',
    'landingLabels',
    'jobLabels',
    'factLabels',
  ] as const;
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
    // The boot scan first, exactly as `keeper()` does it: it stamps the vivarium's
    // start, so the action below falls *after* the boundary rather than racing it.
    // Without it the escalation only hatches while `answer` and `scan` land in the
    // same millisecond, which a loaded runner does not grant.
    pets.scan();
    const id = answer(store, 'a question somebody later pruned');
    pets.scan();
    assert.equal(pets.state()?.pets[0]?.originLabel, 'a question somebody later pruned');
    store.close();

    // The source pruned out from under a pet that is otherwise untouched — a
    // restored backup, or a tidied table.
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
