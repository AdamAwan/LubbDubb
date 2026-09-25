import type { GoalLandingReach } from '../types.js';
import type { GoalPageView } from './goalPage.js';

/**
 * One cell of the reach matrix. `pending` is *not asked yet* — a part with no pull request, or a
 * landing no probe has read — and `unplaced` is a landing the clone says is on no integration
 * branch, which is **dropped from the goal's `total`** and never probed for rather than counted
 * against it. Neither may fold into `absent`, which is a probe that looked and did not find it.
 * → docs/spec/24-environments.md#the-three-verdicts, [what counts](../../../docs/spec/24-environments.md#what-counts-as-a-landing)
 */
export type GoalReachCell = 'reached' | 'absent' | 'unknown' | 'unplaced' | 'pending';

/** One row of the reach matrix: a plan part, or a merge no part claims. */
export interface GoalReachRow {
  key: string;
  kind: 'part' | 'unattributed';
  title: string;
  prNumber: number | null;
  cells: GoalReachCell[];
  /** On no integration branch: dropped from the goal's count rather than held against it. */
  unplaced: boolean;
}

interface GoalReachMatrixView {
  environments: string[];
  rows: GoalReachRow[];
  /** Landings still owed before any check can begin — the AND the rollup takes, said as work. */
  owed: number;
  /** An environment holds every landing this goal owes, so a sheet exists to read. */
  arrived: boolean;
}

/**
 * The goal's parts against the environments, one row each. The counts on
 * `GoalEnvironmentReachView` are the AND over these rows; this is the same reading with the
 * rows kept, which is what lets a partial goal say *which* landing is holding it short rather
 * than only how many are.
 *
 * It computes no verdict of its own — every cell is a status the server already shipped, and a
 * part with no landing is `pending` rather than a guess. → docs/spec/24-environments.md
 *
 * @public the seam the Shipped pane's matrix is drawn from
 */
export function buildGoalReachMatrix(page: GoalPageView): GoalReachMatrixView {
  const environments = page.environments.map((e) => e.environment);
  const byPr = new Map(page.landings.map((l) => [l.prNumber, l]));
  const claimed = new Set<number>();
  const rows: GoalReachRow[] = page.parts.map(({ part }) => {
    const landing = part.prNumber === null ? undefined : byPr.get(part.prNumber);
    if (landing !== undefined) claimed.add(landing.prNumber);
    return {
      key: part.id,
      kind: 'part' as const,
      title: part.title,
      prNumber: part.prNumber,
      cells: environments.map((name) => cellOf(landing, name)),
      unplaced: landing?.unplaced === true,
    };
  });
  for (const landing of page.landings) {
    if (claimed.has(landing.prNumber)) continue;
    /* A merge counted into `total` by `unattributedMerges` and named by no part. It holds the
       rollup exactly as a part does, so it is a row here — left as a footnote it would be a
       thing counted against the goal that appears nowhere on its page. */
    rows.push({
      key: `pr:${landing.prNumber}`,
      kind: 'unattributed',
      title: 'Merged against this goal, claimed by no part',
      prNumber: landing.prNumber,
      cells: environments.map((name) => cellOf(landing, name)),
      unplaced: landing.unplaced,
    });
  }
  const furthest = page.environments.find((e) => e.status === 'partial' || e.status === 'reached');
  return {
    environments,
    rows,
    owed: furthest === undefined ? 0 : furthest.total - furthest.landed,
    arrived: page.environments.some((e) => e.status === 'reached'),
  };
}

function cellOf(landing: GoalLandingReach | undefined, environment: string): GoalReachCell {
  if (landing === undefined) return 'pending';
  if (landing.unplaced) return 'unplaced';
  return landing.reach[environment] ?? 'pending';
}
