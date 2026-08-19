import type { PetActionKind, PetSpecies } from '../types.js';
import { tableFor } from './catalogue.js';

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
}

/**
 * Roll one operator action.
 *
 * **The roll is a hash of the action's own identity, never a random number**, and
 * this is the load-bearing decision in the whole subsystem. A random roll would
 * require the scan to be exactly-once, and the scan is a walk over tables that a
 * restart, a clock change, a restored backup or a re-read can each take twice.
 * Hashing the action makes re-reading it free: the same action produces the same
 * answer forever, so the scan is idempotent by construction rather than by care.
 *
 * `Math.random` here would compile, pass, and turn every re-read into a fresh
 * chance at a pet — with nothing anywhere able to tell that from a first read.
 *
 * The consequence worth keeping in mind is that a drop is a property of the
 * action rather than of when it was looked at: moving `dropChance` re-rolls the
 * actions the scan has not reached yet, and leaves the ones it has.
 */
export function rollAction(
  kind: PetActionKind,
  ref: string,
  at: string,
  opts: { dropChance: number; forced: boolean; firstEver: boolean },
): RollOutcome {
  const key = `${kind}:${ref}`;
  // Local, like `job_schedules.cron` — 2am means 2am where the operator was,
  // not where a server happens to think it is.
  const hour = new Date(at).getHours();
  const table = tableFor(kind, hour, opts.firstEver);
  const hatches = opts.forced || opts.firstEver || hash32(key) % 10_000 < Math.round(opts.dropChance * 10_000);
  return { hatches, species: pick(table, hash32(`${key}:species`)) };
}

/** Weighted pick, indexed by the hash rather than by a draw. */
function pick(table: readonly { species: PetSpecies; weight: number }[], hash: number): PetSpecies {
  const total = table.reduce((sum, entry) => sum + entry.weight, 0);
  // A table is never empty — `tableFor` falls back rather than filtering to
  // nothing — but a zero total would still make the walk below fall off the end.
  if (total <= 0) return table[0]?.species ?? 'pip';
  let cursor = hash % total;
  for (const entry of table) {
    if (cursor < entry.weight) return entry.species;
    cursor -= entry.weight;
  }
  return table[table.length - 1]!.species;
}
