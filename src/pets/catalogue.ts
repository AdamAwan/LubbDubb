import type { PetActionKind, PetRarity, PetSpecies, PetStage } from '../types.js';

/**
 * What each species is, and what it costs to raise.
 *
 * One exported const rather than one export per species: knip runs every rule at
 * `error`, so nine separately-exported records would read as nine unimported
 * symbols the day the ninth is added and nothing imports it directly.
 *
 * `growth` is the multiplier on both stage thresholds. It is what makes a rare
 * animal *feel* rare once the novelty of drawing it has passed — a mythic takes
 * four times the beats a common does to bring up, which is a decision an operator
 * makes about a finite thing rather than a label on a card.
 */
export const SPECIES: Record<PetSpecies, { rarity: PetRarity; display: string; growth: number }> = {
  pip: { rarity: 'common', display: 'Pip', growth: 1 },
  nib: { rarity: 'common', display: 'Nib', growth: 1 },
  tuft: { rarity: 'common', display: 'Tuft', growth: 1 },
  warden: { rarity: 'uncommon', display: 'Warden', growth: 1.6 },
  cinder: { rarity: 'uncommon', display: 'Cinder', growth: 1.6 },
  nocturne: { rarity: 'uncommon', display: 'Nocturne', growth: 1.6 },
  lander: { rarity: 'rare', display: 'Lander', growth: 2.5 },
  quill: { rarity: 'rare', display: 'Quill', growth: 2.5 },
  ouroboros: { rarity: 'mythic', display: 'Ouroboros', growth: 4 },
};

/** Beats to the next stage, before the species' `growth` multiplier. */
const JUVENILE_AT = 1_500;
const ADULT_AT = 8_000;

/**
 * What an action can draw, by weight.
 *
 * Every table includes `pip`, so no action is a dead end — an operator whose week
 * was all human tasks still ends it with something, which is the difference
 * between a feature that rewards a working style and one that judges it.
 *
 * The weights are what make a rarity rare. {@link SPECIES}'s `rarity` is a label
 * for the cockpit and is never an input to the pick: two sources of the same fact
 * is the drift where a card reads `MYTHIC` above the commonest animal in the
 * vivarium.
 */
const DROP_TABLES: Record<PetActionKind, readonly { species: PetSpecies; weight: number }[]> = {
  escalation: [
    { species: 'pip', weight: 60 },
    { species: 'warden', weight: 30 },
    { species: 'nocturne', weight: 20 },
    { species: 'quill', weight: 5 },
  ],
  'human-task': [
    { species: 'pip', weight: 55 },
    { species: 'tuft', weight: 35 },
    { species: 'nocturne', weight: 20 },
  ],
  plan: [
    { species: 'pip', weight: 55 },
    { species: 'nib', weight: 35 },
    { species: 'nocturne', weight: 20 },
    { species: 'quill', weight: 8 },
  ],
  landing: [
    { species: 'pip', weight: 50 },
    { species: 'nocturne', weight: 20 },
    { species: 'lander', weight: 12 },
  ],
  job: [
    { species: 'pip', weight: 60 },
    { species: 'cinder', weight: 30 },
    { species: 'nocturne', weight: 20 },
  ],
  finding: [
    { species: 'pip', weight: 60 },
    { species: 'nocturne', weight: 20 },
    { species: 'quill', weight: 18 },
  ],
  upgrade: [
    { species: 'pip', weight: 40 },
    { species: 'lander', weight: 15 },
    { species: 'ouroboros', weight: 25 },
  ],
};

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

/**
 * The table an action rolls against, narrowed to what it may actually draw.
 *
 * `firstOfKind` drops the commons: the first escalation an operator ever answers
 * is the most memorable action they will take in the harness, and spending it on
 * a `pip` wastes the one moment this feature is guaranteed an audience. When
 * removing them leaves nothing — a table that is all commons — the full one is
 * used rather than nothing being drawn.
 */
export function tableFor(
  kind: PetActionKind,
  hour: number,
  firstOfKind: boolean,
): readonly { species: PetSpecies; weight: number }[] {
  const open = DROP_TABLES[kind].filter((entry) => eligible(entry.species, hour));
  if (!firstOfKind) return open;
  const notable = open.filter((entry) => SPECIES[entry.species].rarity !== 'common');
  return notable.length > 0 ? notable : open;
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
