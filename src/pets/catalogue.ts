import type { PetActionKind, PetRarity, PetSpecies, PetStage } from '../types.js';

/**
 * What each species is, and what it costs to raise.
 *
 * One exported const rather than one export per species: knip runs every rule at
 * `error`, so twenty separately-exported records would read as twenty unimported
 * symbols the day the twentieth is added and nothing imports it directly.
 *
 * `growth` is the multiplier on both stage thresholds and on what a duplicate
 * blends back into. It is what makes a rare animal *feel* rare once the novelty
 * of drawing it has passed — a mythic takes four times the beats a common does to
 * bring up, which is a decision an operator makes about a finite thing rather
 * than a label on a card.
 */
export const SPECIES: Record<PetSpecies, { rarity: PetRarity; display: string; growth: number }> = {
  pip: { rarity: 'common', display: 'Pip', growth: 1 },
  mote: { rarity: 'common', display: 'Mote', growth: 1 },
  nib: { rarity: 'common', display: 'Nib', growth: 1 },
  tuft: { rarity: 'common', display: 'Tuft', growth: 1 },
  beck: { rarity: 'common', display: 'Beck', growth: 1 },
  berth: { rarity: 'common', display: 'Berth', growth: 1 },
  stoke: { rarity: 'common', display: 'Stoke', growth: 1 },
  speck: { rarity: 'common', display: 'Speck', growth: 1 },
  patch: { rarity: 'common', display: 'Patch', growth: 1 },
  warden: { rarity: 'uncommon', display: 'Warden', growth: 1.6 },
  cinder: { rarity: 'uncommon', display: 'Cinder', growth: 1.6 },
  nocturne: { rarity: 'uncommon', display: 'Nocturne', growth: 1.6 },
  chit: { rarity: 'uncommon', display: 'Chit', growth: 1.6 },
  vellum: { rarity: 'uncommon', display: 'Vellum', growth: 1.6 },
  drift: { rarity: 'uncommon', display: 'Drift', growth: 1.6 },
  bramble: { rarity: 'uncommon', display: 'Bramble', growth: 1.6 },
  lander: { rarity: 'rare', display: 'Lander', growth: 2.5 },
  quill: { rarity: 'rare', display: 'Quill', growth: 2.5 },
  cairn: { rarity: 'rare', display: 'Cairn', growth: 2.5 },
  ouroboros: { rarity: 'mythic', display: 'Ouroboros', growth: 4 },
};

/**
 * Commonest first, which is the order a degrade walks *backwards* along: a tier a
 * pool cannot fill steps down this list until one has members.
 *
 * @public — walked by `speciesCandidates` in `src/pets/roll.ts`, which asks what
 * every tier of one action resolves to rather than what one roll landed on.
 */
export const RARITIES: readonly PetRarity[] = ['common', 'uncommon', 'rare', 'mythic'];

/** Beats to the next stage, before the species' `growth` multiplier. */
const JUVENILE_AT = 1_500;
const ADULT_AT = 8_000;

/**
 * Which species each action can draw, **by tier**.
 *
 * The shape is the whole of the Mark Two change. Weights used to live here and
 * decide the species directly, which made a tier an emergent accident of seven
 * hand-tuned tables: a triaged finding produced a rare 23% of the time and an
 * answered escalation 5%, and no sentence beginning "a rare is…" was true of the
 * deployment as a whole. The tier roll now happens once, globally against
 * `PET_RULES.rarity`, and this table only answers *which animal* of the tier that
 * was already rolled.
 *
 * Every action carries **three commons**: the two universals `pip` and `mote`,
 * plus one signature of its own. One common per pool put `pip` at 70% of hatches
 * on five of the seven actions, which is a hundred identical animals before
 * anything else turns up.
 *
 * `nocturne` sits in every uncommon pool and is filtered out unless the action's
 * own timestamp falls at night — still the one species gated on something other
 * than what you were doing.
 */
const POOLS: Record<PetActionKind, Record<PetRarity, readonly PetSpecies[]>> = {
  escalation: {
    common: ['pip', 'mote', 'beck'],
    uncommon: ['warden', 'nocturne'],
    rare: ['quill', 'cairn'],
    mythic: [],
  },
  'human-task': {
    common: ['pip', 'mote', 'tuft'],
    uncommon: ['chit', 'nocturne'],
    rare: [],
    mythic: [],
  },
  plan: {
    common: ['pip', 'mote', 'nib'],
    uncommon: ['vellum', 'nocturne'],
    rare: ['quill'],
    mythic: [],
  },
  landing: {
    common: ['pip', 'mote', 'berth'],
    uncommon: ['drift', 'nocturne'],
    rare: ['lander'],
    mythic: [],
  },
  job: {
    common: ['pip', 'mote', 'stoke'],
    uncommon: ['cinder', 'nocturne'],
    rare: [],
    mythic: [],
  },
  finding: {
    common: ['pip', 'mote', 'speck'],
    uncommon: ['bramble', 'nocturne'],
    rare: ['cairn'],
    mythic: [],
  },
  upgrade: {
    common: ['pip', 'mote', 'patch'],
    uncommon: ['cinder', 'nocturne'],
    rare: ['lander'],
    mythic: ['ouroboros'],
  },
};

/**
 * Every action that can draw something, in the order the pools declare them.
 *
 * Derived from `POOLS` rather than written out again: a kind added to the record
 * and forgotten here is a whole action the Pets page never mentions, and nothing
 * is red — the page simply draws six columns where there are seven.
 *
 * @public — walked by `src/pets/compendium.ts`, which asks what every pool of
 * every kind resolves to rather than what one roll landed on.
 */
export const PET_ACTION_KINDS = Object.keys(POOLS) as readonly PetActionKind[];

/**
 * The hours a `nocturne` can be drawn in, read off the action's own timestamp.
 *
 * The one species whose availability depends on something other than what you
 * were doing, and the reason it reads off the *stored* timestamp rather than the
 * clock: a scan that reached a 2am action at noon must still draw the animal that
 * 2am earned, or the roll would stop being a property of the action.
 */
const NIGHT_FROM = 22;
const NIGHT_TO = 5;

/** Whether a species may be drawn by an action taken at this hour. */
function eligible(species: PetSpecies, hour: number): boolean {
  if (species !== 'nocturne') return true;
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

/** What this action can draw of one tier, at this hour. May be empty. */
function membersOf(kind: PetActionKind, tier: PetRarity, hour: number): readonly PetSpecies[] {
  return POOLS[kind][tier].filter((species) => eligible(species, hour));
}

/**
 * The tier a roll actually lands on, and what it may draw there.
 *
 * A tier the pool cannot fill hands the roll **down** one tier at a time, never
 * up — which is the only way a ceiling is expressed. `human-task` and `job` hold
 * no rare, so their rare and mythic rolls become uncommon; only `upgrade` holds a
 * mythic at all. Degrading upward instead would make the scarcest actions the
 * easiest source of the scarcest animals, which is the inversion Mark Two exists
 * to remove.
 *
 * Returns null only if an action's every tier is empty, which no pool allows —
 * the callers still handle it rather than asserting, because a pool edited badly
 * should hatch nothing rather than throw inside the scan.
 */
export function resolveTier(
  kind: PetActionKind,
  tier: PetRarity,
  hour: number,
): { tier: PetRarity; members: readonly PetSpecies[] } | null {
  for (let i = RARITIES.indexOf(tier); i >= 0; i--) {
    const at = RARITIES[i]!;
    const members = membersOf(kind, at, hour);
    if (members.length > 0) return { tier: at, members };
  }
  return null;
}

/**
 * The tiers a roll may land on, in order, with their weights.
 *
 * `firstEver` drops the commons: the very first action an operator takes in a new
 * deployment is the most memorable one they will take, and spending it on a `pip`
 * wastes the one moment this feature is guaranteed an audience. It fires **once
 * per deployment**, not once per kind — per kind it handed out seven guaranteed
 * pets in an afternoon, most of them rare.
 *
 * When removing the commons would leave nothing — a weight table with every other
 * tier at zero — the full one is used rather than nothing being drawn.
 */
export function tiersFor(
  weights: Record<PetRarity, number>,
  firstEver: boolean,
): readonly { tier: PetRarity; weight: number }[] {
  const all = RARITIES.map((tier) => ({ tier, weight: Math.max(0, weights[tier]) })).filter(
    (entry) => entry.weight > 0,
  );
  if (!firstEver) return all;
  const notable = all.filter((entry) => entry.tier !== 'common');
  return notable.length > 0 ? notable : all;
}

/** What a pet with this much fed into it has grown into. */
export function petStage(species: PetSpecies, fed: number): PetStage {
  const { growth } = SPECIES[species];
  if (fed >= ADULT_AT * growth) return 'adult';
  if (fed >= JUVENILE_AT * growth) return 'juvenile';
  return 'hatchling';
}

/**
 * Beats still owed to reach the next stage, or null for an adult.
 *
 * Computed here and shipped on the wire rather than recomputed in the cockpit,
 * because two implementations of one arithmetic is how a card comes to read
 * `JUVENILE` above a sprite drawn as an adult, with nothing red.
 */
export function beatsToNextStage(species: PetSpecies, fed: number): number | null {
  const { growth } = SPECIES[species];
  if (fed < JUVENILE_AT * growth) return Math.ceil(JUVENILE_AT * growth - fed);
  if (fed < ADULT_AT * growth) return Math.ceil(ADULT_AT * growth - fed);
  return null;
}

/**
 * What blending one duplicate hands back.
 *
 * Scaled by the same `growth` that decides what the animal costs to raise, so a
 * mythic is worth four commons — and deliberately *below* the cost of a stage:
 * at the default yield, dissolving three commons does not fund one to juvenile.
 * Blending is a use for surplus, not a currency press, and the arithmetic is
 * meant to be obvious enough that nobody farms it.
 */
export function blendValue(species: PetSpecies, yieldPerGrowth: number): number {
  return Math.round(yieldPerGrowth * SPECIES[species].growth);
}
