import type { PetActionKind, PetRarity, PetSpecies } from '../types.js';
import { RARITIES, resolveTier, tiersFor } from './catalogue.js';
import type { PetRules } from './rules.js';

/**
 * FNV-1a, 32-bit. Not a cryptographic choice and does not need to be: what is
 * wanted is a *stable* number for a string, on every machine and every boot.
 */
export function hash32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** What one action came to. */
interface RollOutcome {
  hatches: boolean;
  /** The species it would draw. Meaningless unless `hatches`. */
  species: PetSpecies;
  /** The tier that species came from, after any degrade. Meaningless unless `hatches`. */
  tier: PetRarity;
}

/**
 * Roll one operator action, in three stages.
 *
 * **Every stage is a hash of the action's own identity, never a random number**,
 * and this is the load-bearing decision in the whole subsystem. A random roll
 * would require the scan to be exactly-once, and the scan is a walk over tables
 * that a restart, a clock change, a restored backup or a re-read can each take
 * twice. Hashing the action makes re-reading it free: the same action produces
 * the same answer forever, so the scan is idempotent by construction rather than
 * by care. Each stage takes a different salt, so they are independent of one
 * another while staying reproducible.
 *
 * `Math.random` in any of them would compile, pass, and turn every re-read into a
 * fresh chance at a pet — with nothing anywhere able to tell that from a first
 * read.
 *
 * 1. **Does anything hatch?** `PET_RULES.dropChance`, or forced by pity, or the
 *    one guaranteed drop a deployment gets.
 * 2. **Which tier?** One global weighted table, identical for every action, which
 *    is what lets "a rare is 8% of hatches" be true of the deployment rather than
 *    of whichever button was pressed.
 * 3. **Which species?** Uniform among that action's members of the rolled tier —
 *    no weights, because stage 2 has already done the rarity work. Weighting here
 *    too would put rarity back in two places, which is the drift Mark Two removed.
 *
 * **Pity flips stage 1 and stops.** It never touches the tier: a pet you were
 * given because you had been unlucky is exactly as likely to be a mythic as one
 * the roll granted. Making pity pay out worse would turn a consolation into a
 * punishment; making it pay out better would make waiting the strategy.
 */
export function rollAction(
  kind: PetActionKind,
  ref: string,
  at: string,
  opts: { rules: PetRules; forced: boolean; firstEver: boolean },
): RollOutcome {
  const key = `${kind}:${ref}`;
  const hour = hourOf(at);
  const hatches = opts.forced || opts.firstEver || hash32(key) % 10_000 < Math.round(opts.rules.dropChance * 10_000);

  const tiers = tiersFor(opts.rules.rarity, opts.firstEver);
  const rolled = pickTier(tiers, hash32(`${key}:tier`));
  const landed = resolveTier(kind, rolled, hour);
  // A pool with every tier empty cannot happen through the shipped table, but a
  // hatch with nothing to draw must still be a miss rather than a throw inside
  // the scan.
  if (landed === null) return { hatches: false, species: 'pip', tier: 'common' };

  return { hatches, species: pickSpecies(key, landed.members), tier: landed.tier };
}

/**
 * Every species this action could *ever* draw, whatever tier stage 2 lands on.
 *
 * What {@link attestPet} checks a stored pet against, and the reason it is worth
 * having beside {@link rollAction} rather than inside it: an attestation must not
 * depend on the tier weights, because those are a number this build ships and an
 * older build may have shipped differently — a pet from a deployment that once
 * tuned them is still an honestly earned pet, and a check that called it a forgery
 * would take something away from the one operator who had done nothing wrong.
 *
 * Weight-independent and still narrow: an origin key reaches two or three species
 * out of twenty, because stage 3 is a hash of that same key. **You cannot choose
 * which animal an action gives you**, which is the whole of what the check is for.
 *
 * @public — read by `src/pets/attest.ts` across the roll/attest seam.
 */
export function speciesCandidates(kind: PetActionKind, ref: string, at: string): Set<PetSpecies> {
  const key = `${kind}:${ref}`;
  const hour = hourOf(at);
  const out = new Set<PetSpecies>();
  for (const tier of RARITIES) {
    const landed = resolveTier(kind, tier, hour);
    if (landed !== null) out.add(pickSpecies(key, landed.members));
  }
  return out;
}

/**
 * Stage 3, and the only implementation of it.
 *
 * Uniform among the tier's members, indexed by the key's own hash — no weights,
 * because stage 2 has already done the rarity work. Shared with
 * {@link speciesCandidates} so the check and the roll cannot drift: two readings
 * of one arithmetic is how an honest pet comes to fail its own attestation.
 */
function pickSpecies(key: string, members: readonly PetSpecies[]): PetSpecies {
  return members[hash32(`${key}:species`) % members.length]!;
}

/**
 * The action's own hour, local — like `job_schedules.cron`, 2am means 2am where
 * the operator was rather than where a server happens to think it is.
 */
function hourOf(at: string): number {
  return new Date(at).getHours();
}

/** Weighted pick over the tiers, indexed by the hash rather than by a draw. */
function pickTier(table: readonly { tier: PetRarity; weight: number }[], hash: number): PetRarity {
  const total = table.reduce((sum, entry) => sum + entry.weight, 0);
  // `tiersFor` drops zero weights and falls back rather than returning nothing,
  // but a table an operator has zeroed entirely would still make the walk below
  // fall off the end.
  if (total <= 0) return table[0]?.tier ?? 'common';
  let cursor = hash % total;
  for (const entry of table) {
    if (cursor < entry.weight) return entry.tier;
    cursor -= entry.weight;
  }
  return table[table.length - 1]!.tier;
}
