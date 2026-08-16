import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TicketsPayload } from '../../wire.js';
import { buildSpendGoals } from '../../spendInsights.js';
import { buildTicketPage } from '../../tickets/ticketList.js';
import { ticketOutcomes } from '../../tickets/outcomes.js';
import { watchLabelsFor } from '../../watchLabels.js';
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
  watch: z.enum(['any', 'watched', 'unwatched', 'ignored']).default('any'),
  state: z.enum(['any', 'open', 'closed']).default('any'),
  order: z.enum(['added', 'cost']).default('added'),
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
      const { watchLabel, ignoreLabel } = watchLabelsFor(config.labelPrefix);
      // Titles only, and a goal missing from the baseline still gets its row — the
      // money was spent whether or not the world still lists the ticket.
      const { goals } = buildSpendGoals({
        agents: store.listAgents(),
        tasks: store.listTasks(),
        nodes: store.listWorkNodes(),
        issues: store.getWorldBaseline()?.issues ?? [],
      });
      const page = buildTicketPage({
        items: store.listTrackerItems(),
        costs: new Map(goals.map((g) => [g.issueNumber, g.costUsd])),
        outcomes: ticketOutcomes({
          runs: store.listIssueRuns(),
          conclusions: store.listIssueConclusions(),
          deliveries: store.listDeliveries(),
          shortfalls: store.listShortfalls(),
          plans: store.listPlans(),
          planParts: store.listAllPlanParts(),
        }),
        watchLabel,
        ignoreLabel,
        query: { watch: query.watch, state: query.state, order: query.order, cursor: query.cursor ?? null },
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
