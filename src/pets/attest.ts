import type { Pet, PetAction, PetFlaw, PetProvenance } from '../types.js';
import { chainLink, type ChainInput } from '../store/pets.js';
import { SPECIES } from './catalogue.js';
import { rollAction, speciesCandidates } from './roll.js';
import type { PetRules } from './rules.js';

/**
 * What a pet is checked against: the record of the actions that were rolled, and
 * what each pet's purchases actually paid for.
 *
 * Both are read once per snapshot and shared across the whole vivarium, because
 * the alternative — a query per card — is a walk of two tables per pet on a
 * surface the socket redraws constantly.
 */
export interface PetLedger {
  /** `<kind>:<ref>` → the `pet_actions` row the scan wrote when it rolled it. */
  actions: Map<string, { at: string; petId: string | null }>;
  /** Pet id → the beats its `pet_purchases` rows account for. */
  paid: Map<string, number>;
  /** Pet id → the link its position in the chain says it should carry. */
  chain: Map<string, string>;
  /**
   * Action keys the shipped rules say should **not** have hatched.
   *
   * Only consulted for a pet the running build stamped itself, because the rules
   * that decided it are the rules this build holds — see {@link judgeable}.
   */
  barren: Set<string>;
  /** The build doing the judging: `{sha, clean}` of the running install. */
  build: { sha: string | null; clean: boolean };
}

/**
 * Which of the actions in the log the shipped rules would have hatched nothing on.
 *
 * **Replays position by position rather than simulating the whole sequence.** At
 * each action the pity counter is taken from what the table *records* — the rows
 * before it that hatched — rather than from what this replay would have done. The
 * difference matters: a simulated counter that diverges once (a pet hatched under
 * different rates, a restored backup) stays diverged, and every action after it is
 * judged against a history that never happened. Reading the counter off the record
 * keeps each decision local and correct.
 *
 * What this closes: taking the rates out of the config stops the config route to a
 * free vivarium, and stops nothing for somebody editing `src/pets/rules.ts`. A
 * replay against the shipped constants sees those hatches for what they are.
 */
export function replayBarren(log: PetAction[], rules: PetRules): Set<string> {
  const barren = new Set<string>();
  let sinceHatch = 0;
  for (const [index, action] of log.entries()) {
    const roll = rollAction(action.kind, action.ref, action.at, {
      rules,
      forced: sinceHatch + 1 >= rules.pity,
      firstEver: index === 0,
    });
    if (!roll.hatches) barren.add(`${action.kind}:${action.ref}`);
    sinceHatch = action.petId === null ? sinceHatch + 1 : 0;
  }
  return barren;
}

/**
 * Every link the chain should hold, recomputed from the rows in insertion order.
 *
 * A pet edited or slipped into the middle breaks its own link and every link after
 * it. A pet appended to the end does not — a forger chains onto the newest link as
 * easily as the harness does — which is why this is one check of several.
 */
export function replayChain(log: { id: string; link: ChainInput }[]): Map<string, string> {
  const out = new Map<string, string>();
  let previous: string | null = null;
  for (const row of log) {
    previous = chainLink(previous, row.link);
    out.set(row.id, previous);
  }
  return out;
}

/**
 * What kind of build hatched a pet.
 *
 * `unknown` covers every pet from before the stamp and every deployment that is
 * not a git checkout, and it is not a suspicion — the checks that could accuse a
 * pet decline to judge an unknown build rather than assuming the worst of it.
 */
export function provenanceOf(pet: Pet): PetProvenance {
  if (pet.builtSha === null) return 'unknown';
  return pet.builtClean ? 'official' : 'modified';
}

/**
 * Whether the running build is entitled to an opinion about how this pet hatched.
 *
 * Only when the pet says it was rolled by **this** build, out of a clean checkout.
 * Anything else — an older build, a fork, a modified tree, no reading at all — was
 * decided by constants this process does not hold, and a replay against the wrong
 * constants accuses pets that were properly earned under the right ones. That is
 * the failure worth avoiding above all others here: it lands on somebody else's
 * machine, months later, and tells an honest operator their collection is fake.
 */
function judgeable(pet: Pet, build: { sha: string | null; clean: boolean }): boolean {
  return build.sha !== null && build.clean && pet.builtSha === build.sha && pet.builtClean;
}

/**
 * Whether a pet is what it says it is.
 *
 * **Tamper-evident, not tamper-proof, and the difference is worth stating once.**
 * The vivarium lives in a SQLite file the operator owns, so nothing here can stop
 * somebody writing rows into it — no local check can, and a design that claimed
 * otherwise would be lying. What this does is make a fabricated pet have to agree
 * with three tables at once, and make the one thing anybody would forge for — a
 * particular animal — the thing that cannot be chosen:
 *
 * - **`unrecorded`** — no rolled action claims it. A row appended to `pets` alone
 *   fails here, which is the whole of the cheap forgery.
 * - **`misdated`** — it hatched at a different moment than the action it names was
 *   settled. The hour is load-bearing: it is what decides whether a `nocturne`
 *   could have been drawn at all.
 * - **`impossible`** — its species, or its seed, is not something that origin can
 *   produce. Stage 3 is a hash of the action's own key, so one action reaches two
 *   or three species out of twenty and **never the one you wanted** — a forger has
 *   to grind for an origin ref that happens to give them the animal, and the ref
 *   has to belong to a real settled thing.
 * - **`overfed`** — it has grown by more beats than its purchases paid for, which
 *   is the other half of the exploit: feeding is what a fabricated wallet buys.
 * - **`broken-chain`** — its link, or a link before it, does not recompute. Catches
 *   an edit and an insertion into the middle; not an append.
 * - **`unearned`** — the shipped rules would have hatched nothing on that action.
 *   Only ever raised against a pet this same clean build stamped itself, because
 *   any other pet was decided by constants this process does not hold.
 *
 * Returns the first flaw found rather than all of them, because the checks fall
 * over each other — a misdated pet rolls a different hour and would report an
 * impossible species too, and the earlier answer is the truer one.
 *
 * A flawed pet is **shown, never deleted**: it keeps its card and its origin line,
 * and simply cannot be fed, put out or blended. Blending is the one that matters —
 * it is the only route from a pet back into beats, and an unchecked one would let
 * a hand-written row be laundered into food for the honest animals beside it.
 */
export function attestPet(pet: Pet, ledger: PetLedger): PetFlaw | null {
  const key = `${pet.originKind}:${pet.originRef}`;
  const action = ledger.actions.get(key);
  if (action === undefined || action.petId !== pet.id)
    return { code: 'unrecorded', note: 'nothing in the record of what you have done accounts for this one' };
  if (action.at !== pet.hatchedAt)
    return { code: 'misdated', note: 'it hatched at a different moment than the action it names was settled' };
  if (pet.seed !== key)
    return { code: 'impossible', note: 'its markings are drawn from a seed that is not its own origin' };
  if (!speciesCandidates(pet.originKind, pet.originRef, pet.hatchedAt).has(pet.species))
    return {
      code: 'impossible',
      note: `no roll of ${pet.originRef} can produce a ${SPECIES[pet.species].display}`,
    };
  if (pet.fed > (ledger.paid.get(pet.id) ?? 0))
    return { code: 'overfed', note: 'it has grown by more beats than anything ever paid for' };
  // Skipped rather than failed when the column is empty: a pet from before the
  // chain existed carries no link, and calling that a forgery would accuse every
  // collection that predates this check.
  const expected = ledger.chain.get(pet.id);
  if (pet.chain !== null && expected !== undefined && pet.chain !== expected)
    return { code: 'broken-chain', note: 'the record of hatchings does not run through it' };
  if (judgeable(pet, ledger.build) && ledger.barren.has(key))
    return { code: 'unearned', note: `this build would have hatched nothing on ${pet.originRef}` };
  return null;
}
