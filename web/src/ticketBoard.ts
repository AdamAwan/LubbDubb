import type { Issue, TicketRow, TicketStateFacet } from './types.js';
import { watchBucket } from './worldBuckets.js';

/**
 * The card view's own pure decisions: which columns exist, what a card's reason line
 * says, and what a drop would cost.
 *
 * All three are here rather than in the components for the reason `cascadeNote` and
 * `watchReading` are pure — each is a statement about *which of several readings
 * wins*, and no render can show that. A board that drew the wrong column order, the
 * wrong sentence under a card, or the wrong warning on a header would look exactly
 * like one that drew the right one.
 *
 * → docs/spec/17-cockpit.md#the-tickets-tab
 */

/** One column of the board: a state, what is in it, and what the harness makes of it. */
export interface BoardColumn {
  state: string;
  /** Every mirrored item in this state, before the rail's filters. */
  count: number;
  /** How many of those are still in the tracker's open set. */
  live: number;
  /** A state the dispatcher's effective gate lets through. */
  pickup: boolean;
  /** True for a column the config names that the mirror has nothing in. */
  empty: boolean;
}

/**
 * The columns to draw, in order, and the states that get none.
 *
 * An **empty** `boardStates` falls back to the facets, which the route already sorts
 * by count — a deployment with nothing configured gets a working board, in the order
 * its State tier already shows. A configured order is taken exactly as written,
 * including a state nothing is in: naming a column is the operator saying they expect
 * work there, and quietly dropping it would make the board disagree with the config
 * file they are reading, on exactly the day that state went quiet.
 *
 * `unlisted` is the other half of the same honesty. A state the mirror carries that
 * the config omits has no column, so its items are on no board at all — reported so a
 * short list reads as a choice and a typo reads as a mistake, rather than both reading
 * as a quiet tracker.
 *
 * `pickup` is resolved from one list for every column, facet-backed or not: reading
 * the facet's own flag where there is one and the list where there is not would be two
 * answers to the question that decides whether a header warns the fleet will stop.
 */
export function boardColumns(
  boardStates: readonly string[],
  facets: readonly TicketStateFacet[],
  pickup: readonly string[],
): { columns: BoardColumn[]; unlisted: TicketStateFacet[] } {
  const byState = new Map(facets.map((facet) => [facet.state, facet]));
  const gate = new Set(pickup);

  if (boardStates.length === 0) {
    return {
      columns: facets.map((facet) => ({
        state: facet.state,
        count: facet.count,
        live: facet.live,
        pickup: gate.has(facet.state),
        empty: false,
      })),
      unlisted: [],
    };
  }

  // Trimmed and deduplicated because the key is hand-editable: a repeat would give
  // two columns one fetch and one drop target each, which is two places to leave
  // disagreeing about one state.
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const raw of boardStates) {
    const state = raw.trim();
    if (state === '' || seen.has(state)) continue;
    seen.add(state);
    wanted.push(state);
  }

  return {
    columns: wanted.map((state) => {
      const facet = byState.get(state);
      return {
        state,
        count: facet?.count ?? 0,
        live: facet?.live ?? 0,
        pickup: gate.has(state),
        empty: facet === undefined,
      };
    }),
    // The facets' own order, so the largest omission reads first.
    unlisted: facets.filter((facet) => !seen.has(facet.state)),
  };
}

/** Which of the five readings the lane is drawing, so the card can tint it. */
type CardReasonTone = 'held' | 'outcome' | 'pickup' | 'frozen' | 'unwatched';

/**
 * The sentence under a card, and which of five readings supplied it.
 *
 * Precedence is the whole subject, and each step earns its place:
 *
 * 1. **Held at intake** — an unclear appraisal is the one reading that stops dispatch, so
 *    among a column of cards it must not read as a detail.
 * 2. **The outcome word** — the harness has finished deciding, which outranks its
 *    account of what it would do next.
 * 3. **The dispatcher's first reason**, quoted whole.
 * 4. **Frozen** — nothing in the tracker's open set has a next cycle to explain.
 * 5. **Unwatched** — nobody opted it in, which is why nothing has an opinion.
 *
 * An **unwatched** item is never held, whatever a stale verdict says: nothing appraisals a
 * goal nobody opted in, so a verdict on one is left over from before it was dropped,
 * and the drop outranks it. That is the table's rule, and reading it the other way
 * would light the intake lamp on work the harness has been told to leave alone.
 *
 * The watch reading comes from the **world** where the world holds the item and the
 * mirror only where it does not — `watchReading`'s rule, for its reason: the tab does
 * not refetch its page on a click, so believing the mirror first is a lane that goes
 * on saying "not watched" after the tag has landed.
 *
 * `frozenAge` arrives already formatted, so this stays free of the clock and every
 * case is assertable without one.
 */
export function cardReason(
  row: TicketRow,
  issue: Issue | null,
  watchLabel: string,
  frozenAge: string,
): { tone: CardReasonTone; words: string } {
  const watched = (issue === null ? row.watch : watchBucket(issue.labels, watchLabel)) === 'watched';

  if (watched && issue?.appraisal?.verdict === 'unclear') {
    return { tone: 'held', words: 'held at intake — the appraisal is unclear, so nothing under it moves' };
  }
  if (row.outcome !== null) return { tone: 'outcome', words: row.outcome };

  const reason = issue?.pickup.reasons[0];
  if (reason !== undefined) return { tone: 'pickup', words: reason };

  if (row.tracking === 'frozen') {
    return { tone: 'frozen', words: `frozen${frozenAge === '' ? '' : ` · last change ${frozenAge}`}` };
  }
  if (!watched) return { tone: 'unwatched', words: 'not watched — nobody has opted this in' };
  // The absence is a reading too: a blank lane reads as a card that failed to draw,
  // which is the one thing an always-drawn lane exists to avoid.
  return { tone: 'pickup', words: 'waiting to be picked up' };
}

/** How loudly a column's header speaks while a card is in the air. */
type DropTone = 'none' | 'ok' | 'warn' | 'stop';

/**
 * The state words the work-item rules act on — `CockpitConfig.stateRules`, named here
 * so this file does not import a wire type it reads four fields of.
 */
export interface StateRules {
  /** The dispatcher's *effective* pickup set, `inProgress` folded in. */
  pickup: string[];
  inProgress: string | null;
  inReview: string | null;
  /** Where `work-item-back-to-pickup` returns an item: the first configured pickup state. */
  returnsTo: string | null;
}

/**
 * What dropping a card on this column would cost, said before the drop rather than
 * discovered after it — the habit `stateWhy` and `cascadeNote` already keep.
 *
 * **Clauses, not cases.** The facts are independent: a column can be outside the
 * pickup gate *and* the one a rule writes *and* hold nothing live. An enumeration
 * would have to choose which of the three to report, and whichever it chose would be
 * the one the operator needed the other time.
 *
 * Three points where the obvious wording is wrong, each checked against the rules
 * themselves:
 *
 * - **The in-progress state is a pickup state**, even where `issuePickupStates` does
 *   not name it — `effectivePickupStates` folds it in and `src/config.ts` says it
 *   should not be listed. Reading the raw key would tell the operator that moving a
 *   card to "Doing" stops the fleet.
 * - **`workItemBackToPickup` fires only on an explicit `more_work` verdict**, never on
 *   a missing PR. "A rule may move this back" overstates it; the words name the
 *   condition.
 * - **A state with nothing live does not mean dropping there closes the item.**
 *   Whether a state maps to closed is the tracker's workflow, which the harness has no
 *   reading of, so the clause states only the fact the State tier already states.
 *
 * A null `rules` is the deployment with no state gate at all, where all three rules
 * are switched out — so the drop is a tracker fact and nothing else, and saying more
 * would warn about a mechanism that is not running.
 */
export function dropWarning(
  column: BoardColumn,
  from: string | null,
  rules: StateRules | null,
): { tone: DropTone; words: string } {
  if (from !== null && column.state === from) return { tone: 'none', words: 'where it is now' };
  if (rules === null) {
    return { tone: 'none', words: 'no state gate is configured — this changes the tracker and nothing else' };
  }

  const parts: string[] = [
    column.pickup
      ? 'a pickup state — the fleet can work this'
      : 'leaves the pickup states — the fleet stops picking this up',
  ];
  let tone: DropTone = column.pickup ? 'ok' : 'stop';

  if (column.state === rules.inProgress) {
    parts.push('a rule moves items here itself once an agent starts');
  }
  if (column.state === rules.inReview && rules.returnsTo !== null) {
    tone = 'warn';
    parts.push(`work-item-back-to-pickup returns it to "${rules.returnsTo}" if a verdict reports work outstanding`);
  }
  if (column.live === 0 && column.count > 0) {
    if (tone !== 'stop') tone = 'warn';
    parts.push('nothing under this state is still in the tracker’s open set');
  }

  return { tone, words: parts.join(' · ') };
}
