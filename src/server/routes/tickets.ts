import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TicketStateFilter, TicketTrackingFilter, TicketsPayload } from '../../wire.js';
import { effectivePickupStates } from '../../dispatcher/issuePickup.js';
import { buildSpendGoals } from '../../spendInsights.js';
import { buildTicketPage, NO_FEATURE } from '../../tickets/ticketList.js';
import { ticketOutcomes } from '../../tickets/outcomes.js';
import { watchLabelFor } from '../../watchLabels.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The two filter axes, the ordering and the page cursor.
 *
 * Every one defaults, because a bare `/api/tickets` is the tab's own first
 * request and "all items, newest first" is what that means. Defaulting here rather
 * than in the panel is what keeps the cockpit's bare `?tab=tickets` and this
 * route's bare path the same place — the query string omits defaults, so the two
 * have to agree about what an absent parameter means.
 */
const TicketQuery = z.object({
  watch: z.enum(['any', 'watched', 'unwatched']).default('any'),
  /**
   * Defaults to `live`, and that is a deliberate change of what a bare
   * `/api/tickets` means: the tab is a work surface now rather than a record of
   * one, and opening it on a thousand closed rows would bury the ninety that are
   * still work. The history is one click away and still all there.
   */
  tracking: z.enum(['any', 'live', 'frozen']).default('live'),
  /**
   * Free-form because it is the *tracker's* word, validated only for length.
   * `open` and `closed` are accepted as aliases for the old two-valued `state`
   * axis (below) — no tracker spells a state that way, and a saved link that
   * silently matched nothing would be worse than an alias that is written down.
   */
  state: z.string().max(80).default('any'),
  /** A feature number, or `none` for the items the tracker says have no parent. */
  feature: z.string().max(20).optional(),
  order: z.enum(['added', 'changed', 'cost']).default('added'),
  // Opaque to the caller and validated only for length: it is this route's own
  // output handed back, and a malformed one restarts the list rather than refusing
  // the request (see `afterCursor`) — repeating rows is a failure a reader can see,
  // a refused scroll is one they can only report.
  cursor: z.string().max(64).optional(),
});

/**
 * The Tickets tab's list: every item the tracker's assignment filter has returned
 * since the harness first swept, filtered by the harness's reading and the
 * tracker's, and orderable by what the fleet spent under it (issue #329).
 *
 * **Fetched, never polled.** It rides its own route rather than `/api/state` for
 * the work graph's reason: the snapshot comes round every couple of seconds for
 * every open cockpit, and this list is all-time and only grows.
 *
 * Three readings are *quoted* rather than re-derived, and each of the three has
 * already caused a drift somewhere in this codebase when it was not:
 *
 * - **which goal a run's money belongs to** is `buildSpendGoals`' answer, the same
 *   one the Spend panel draws;
 * - **what the harness made of a goal** is `resolveIssueConclusion`'s, folded to
 *   one word server-side by `ticketOutcomes`;
 * - **whether an item is watched** is the label precedence in `src/watchLabels.ts`,
 *   the same function the dispatcher's gate resolves through.
 *
 * It is a lens. Nothing here decides anything, and no rule under `src/dispatcher/`
 * reads the table behind it.
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, connector, config } = system;

  // Rate-limited for `/api/work`'s reason: it reads the mirror and the whole agent
  // list on demand rather than on the cockpit's poll. A scroll spends one call per
  // page, so the ceiling is far above any real interaction.
  const TICKETS_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get(
    '/api/tickets',
    TICKETS_RATE_LIMIT,
    checked({ query: TicketQuery }, async ({ query }) => {
      const watchLabel = watchLabelFor(config.labelPrefix);
      // Read once: the goal names below and the outcomes further down are two
      // readings of the same record.
      const runs = store.listIssueRuns();
      // Titles only, and a goal missing from the baseline still gets its row — the
      // money was spent whether or not the world still lists the ticket.
      const { goals } = buildSpendGoals({
        agents: store.listAgents(),
        tasks: store.listTasks(),
        nodes: store.listWorkNodes(),
        issues: store.getWorldBaseline()?.issues ?? [],
        runs,
      });
      const items = store.listTrackerItems();
      // Assigned here rather than by the sweep, because a feature earns a colour by
      // being *drawn* — a slot spent on a parent nobody ever sees would push the
      // features a reader does see further round the ladder.
      const featureSlots = store.ensureFeatureColors(
        items.flatMap((item) => (item.parent ? [item.parent.number] : [])),
      );
      const page = buildTicketPage({
        items,
        featureSlots,
        // The dispatcher's own effective set, not the raw key: `issueInProgressState`
        // is folded in there and deliberately not listed here, so a facet built from
        // the raw list marks the in-progress state as one the harness will not work.
        // A lens quoting a decision made elsewhere, which is the allowed direction.
        pickupStates:
          effectivePickupStates({
            pickupStates: config.issuePickupStates,
            inProgressState: config.issueInProgressState,
          }) ?? [],
        costs: new Map(goals.map((g) => [g.issueNumber, g.costUsd])),
        outcomes: ticketOutcomes({
          runs,
          conclusions: store.listIssueConclusions(),
          deliveries: store.listDeliveries(),
          shortfalls: store.listShortfalls(),
          plans: store.listPlans(),
          planParts: store.listAllPlanParts(),
        }),
        watchLabel,
        query: {
          watch: query.watch,
          ...coarseAxes(query.tracking, query.state),
          feature: parseFeature(query.feature),
          order: query.order,
          cursor: query.cursor ?? null,
        },
      });

      // Resolved off the connector, not read from the snapshot's `refUrls`: that
      // map is built from the world, and a ticket this list remembers left it long
      // ago. Only the page's own rows, so the cost is a page rather than the mirror.
      const refUrls: Record<string, string> = {};
      for (const row of page.rows) {
        const url = connector.resolveRefUrl(`issue:${row.number}`);
        if (url) refUrls[`issue:${row.number}`] = url;
      }

      return {
        ...page,
        // The floor under the history, and whether it is still being filled. Both
        // are the tab's to *say*: a list that stopped with no explanation reads as
        // one that failed, and an empty list mid-backfill looks exactly like an
        // empty tracker.
        anchorAt: system.tickets.anchorAt ?? '',
        backfilling: system.tickets.backfilling,
        refUrls,
      } satisfies TicketsPayload;
    }),
  );
}

/**
 * The two coarse axes, and the one alias between them.
 *
 * `state` used to be `open` / `closed` and is now the tracker's own word, with the
 * harness's reading moved to `tracking`. Those two literals are therefore the one
 * ambiguous input this route can receive — and since no tracker spells a state
 * that way (Azure capitalises, GitHub has none at all), reading them as the old
 * axis is unambiguous in practice and keeps every saved link and bookmark working.
 * The alternative is a filter that quietly matches nothing, which is the failure
 * this codebase spends the most effort refusing.
 */
function coarseAxes(
  tracking: TicketTrackingFilter,
  state: string,
): { tracking: TicketTrackingFilter; state: TicketStateFilter } {
  if (state === 'open') return { tracking: 'live', state: 'any' };
  if (state === 'closed') return { tracking: 'frozen', state: 'any' };
  return { tracking, state };
}

/** A feature number, the orphan bucket, or null for every feature. Junk narrows nothing. */
function parseFeature(raw: string | undefined): number | typeof NO_FEATURE | null {
  if (raw === undefined || raw === '') return null;
  if (raw === NO_FEATURE) return NO_FEATURE;
  const number = Number(raw);
  return Number.isInteger(number) && number > 0 ? number : null;
}
