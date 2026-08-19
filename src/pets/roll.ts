import type { PetActionKind, PetRarity, PetSpecies } from '../types.js';
import { resolveTier, tiersFor } from './catalogue.js';

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
 * 1. **Does anything hatch?** `dropChance`, or forced by pity, or the one
 *    guaranteed drop a deployment gets.
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
  opts: { dropChance: number; forced: boolean; firstEver: boolean; rarity: Record<PetRarity, number> },
): RollOutcome {
  const key = `${kind}:${ref}`;
  // Local, like `job_schedules.cron` — 2am means 2am where the operator was,
  // not where a server happens to think it is.
  const hour = new Date(at).getHours();
  const hatches = opts.forced || opts.firstEver || hash32(key) % 10_000 < Math.round(opts.dropChance * 10_000);

  const tiers = tiersFor(opts.rarity, opts.firstEver);
  const rolled = pickTier(tiers, hash32(`${key}:tier`));
  const landed = resolveTier(kind, rolled, hour);
  // A pool with every tier empty cannot happen through the shipped table, but a
  // hatch with nothing to draw must still be a miss rather than a throw inside
  // the scan.
  if (landed === null) return { hatches: false, species: 'pip', tier: 'common' };

  const species = landed.members[hash32(`${key}:species`) % landed.members.length]!;
  return { hatches, species, tier: landed.tier };
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
