import type { PetActionKind, PetRarity } from '../types.js';

/**
 * The numbers the roll and the wallet run on.
 *
 * **Constants, and deliberately not configuration.** Every one of them used to be
 * a key under `pets` in `lubbdubb.config.json`, and every one of them was a way of
 * writing a pet into existence without doing anything: `dropChance: 1` hatches on
 * every action, `pity: 1` does the same by another road, a `rarity` table zeroed
 * everywhere but `mythic` turns the scarcest animal in the catalogue into the only
 * one, and `beatsPerDollar` at a large enough number raises a whole vivarium on a
 * single dollar of spend. None of that reads as cheating from inside the cockpit —
 * the pets arrive through the ordinary scan, carry real origin lines, and look
 * exactly like earned ones.
 *
 * A collection is only worth having if it cost what it says it cost, so the price
 * is the same on every deployment and nothing an operator can edit moves it. What
 * is left under `pets` is `enabled`, which hides the feature and can mint nothing.
 *
 * Frozen rather than merely `const`: the fields are read on every scan, and a
 * module that assigned one at runtime would be the same hole reopened from inside.
 *
 * → `docs/spec/22-pets.md#authenticity`
 */
export interface PetRules {
  /** What one action of each kind is worth, and how long it may go unrewarded. */
  rates: Record<PetActionKind, PetActionRate>;
  /**
   * The tier weights stage 2 rolls, as whole numbers over their own total.
   *
   * Global on purpose: rolling rarity here rather than inside each action's table
   * is what lets "a rare is 8% of hatches" be a fact about the deployment. An
   * action whose pool cannot fill a tier degrades downward — it never re-rolls,
   * and never reaches up.
   */
  rarity: Record<PetRarity, number>;
  /** Beats per dollar of fleet spend. The only conversion in the subsystem. */
  beatsPerDollar: number;
  /** Beats a blended duplicate hands back, per point of the species' `growth`. */
  blendYield: number;
}

/** One action kind's price, and its ceiling. */
export interface PetActionRate {
  /** Chance one action of this kind hatches something, before pity. */
  dropChance: number;
  /**
   * Actions **of this kind** without a hatch before the next one is forced.
   *
   * Twice the expected gap (`2 / dropChance`), so pity is a *ceiling* rather than
   * a schedule: you can be unlucky, never more than twice-unlucky, and the roll
   * still decides the great majority of drops. Set near the expected gap it
   * becomes the schedule instead — at a drop chance of 0.02 and a pity of 15 it
   * supplied three pets in four, and lowering the drop chance moved nothing.
   */
  pity: number;
}

/**
 * The one table, on every deployment.
 *
 * **Priced against how often the action happens, not against how it feels.** A
 * single global rate reads as fair and is not: the harness settles jobs and
 * findings by the dozen and accepts an upgrade a handful of times a year, so one
 * chance in fifty everywhere means a collection drawn almost entirely from
 * whichever button the deployment happens to press most — and it means the
 * animals behind the scarce actions are never seen by anybody. The gap is wider
 * than it looks, because an `upgrade` is one action per accepted self-update
 * keyed on upstream's tip, not one per commit the pull brings in.
 *
 * So the rate runs the other way: roughly inverse to how often the action comes
 * up, which is what makes a landing worth authorising for its own sake and stops
 * a busy afternoon of job launches from being the whole vivarium. Each `pity` is
 * twice its own kind's expected gap, and each is counted over that kind alone —
 * a shared counter spent its ceiling on whatever was most frequent and left the
 * rare actions no floor at all.
 *
 * Generous early and slow later: a working week of ordinary use produces a handful
 * of creatures, and a common takes about ten days of a thirty-dollar fleet to
 * raise. An empty vivarium is still the failure mode worth watching for — but the
 * answer to one is now a change here, in a release everybody gets, rather than a
 * dial one deployment turns and the rest do not.
 */
export const PET_RULES: PetRules = Object.freeze({
  rates: Object.freeze({
    job: Object.freeze({ dropChance: 0.015, pity: 130 }),
    finding: Object.freeze({ dropChance: 0.02, pity: 100 }),
    'human-task': Object.freeze({ dropChance: 0.03, pity: 66 }),
    escalation: Object.freeze({ dropChance: 0.04, pity: 50 }),
    plan: Object.freeze({ dropChance: 0.05, pity: 40 }),
    landing: Object.freeze({ dropChance: 0.08, pity: 25 }),
    upgrade: Object.freeze({ dropChance: 0.2, pity: 10 }),
  }),
  rarity: Object.freeze({ common: 700, uncommon: 200, rare: 80, mythic: 20 }),
  beatsPerDollar: 25,
  blendYield: 500,
});
