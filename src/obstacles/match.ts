import { claimKey, claimsMatch } from '../claims.js';
import type { GatedKey } from './keys.js';

/**
 * Which obstacle a report joins, and — where none — what it is merely *near*.
 *
 * **Keys merge; a model suggests.** Deciding two reports are one obstacle is the
 * one job in this subsystem no model may do, because a wrong merge hides one
 * agent's report inside another's: the swallowed report is answered *already
 * owned*, nobody fixes it, and nothing is red. A duplicate row costs a few hundred
 * bytes and can be seen.
 *
 * Pure — no I/O, no clock, no store. The index arrives as a lookup function, which
 * is what lets `test/obstacleMatch.test.ts` hold the whole of the rule without a
 * database. → `docs/spec/27-obstacles.md#identity-is-a-key`
 */

/** A row as the near-match pass reads it. */
export interface NearCandidate {
  id: string;
  what: string;
}

/** Why a report landed where it did. */
interface ObstacleMatch {
  obstacleId: string;
  /** The key that bound it, spelled as it is recorded on the sighting. */
  matchedBy: string;
}

/**
 * The keys that may resolve an obstacle, and it is **fewer than the keys that
 * bind**.
 *
 * A `check` key never binds on its own: a key coarse enough to catch everything
 * catches everything, and then the fleet is told a genuinely new failure is
 * already owned. That failure is silent. So a check must co-occur with a `test` or
 * a `path` key, and a report carrying only a check name files fresh.
 *
 * A `signature` does not rescue a bare `check`, and that is the pair of rules
 * meeting rather than one of them having an exception: a key that cannot bind
 * alone cannot make another one bind either, or "does not bind" would mean *binds
 * when convenient*.
 */
export function resolvingKeys(keys: readonly GatedKey[]): GatedKey[] {
  const binding = keys.filter((key) => key.binds);
  const locates = binding.some((key) => key.kind === 'test' || key.kind === 'path');
  return locates ? binding : [];
}

/**
 * The obstacle this report joins, or null.
 *
 * **Exact and never a prefix**, which is `priorRemedies`' choice
 * (`docs/spec/07-pull-requests.md`) and the same fragility accepted for the same
 * reason: a check name is a provider identifier, and a prefix match puts another
 * job's history in front of an agent under a name it reads as its own.
 *
 * The first hit in key order wins, and the order is the report's own — so a
 * `test` key an agent named itself is consulted before a check the harness read
 * off the dispatch.
 */
export function matchObstacle(
  keys: readonly GatedKey[],
  lookup: (value: string) => string | null,
): ObstacleMatch | null {
  for (const key of resolvingKeys(keys)) {
    const obstacleId = lookup(key.value);
    if (obstacleId !== null) return { obstacleId, matchedBy: `${key.kind}:${key.value}` };
  }
  return null;
}

/**
 * Rows a report looks like but did not join: the prose matcher's hits, and the
 * hits of the keys that only ever suggest.
 *
 * `claimsMatch` is the matcher this whole document replaces — equality or
 * containment above a 24-character floor, over prose two agents wrote in their own
 * words. It is kept **only here**, where a wrong answer is a line an agent may
 * ignore rather than a report swallowed, and it binds nothing.
 */
export function nearMatches(input: {
  what: string;
  keys: readonly GatedKey[];
  rows: readonly NearCandidate[];
  lookup: (value: string) => string | null;
  /** The row the report actually landed on, which is never near itself. */
  exclude?: string | null;
}): NearCandidate[] {
  const key = claimKey(input.what);
  const hits = new Map<string, NearCandidate>();
  const rows = new Map(input.rows.map((row) => [row.id, row]));
  for (const row of input.rows) {
    if (row.id === input.exclude) continue;
    if (claimsMatch(key, claimKey(row.what))) hits.set(row.id, row);
  }
  // A signature or a command the board already holds is the strongest suggestion
  // there is, and it is still only a suggestion: an agent or an operator confirms
  // it by id.
  for (const candidate of input.keys.filter((k) => !k.binds)) {
    const id = input.lookup(candidate.value);
    if (id === null || id === input.exclude) continue;
    const row = rows.get(id);
    if (row !== undefined) hits.set(id, row);
  }
  return [...hits.values()];
}
