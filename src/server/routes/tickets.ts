import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueOriginRef } from '../../issueOrigins.js';
import type { TicketStateFilter, TicketTrackingFilter, TicketsPayload } from '../../wire.js';
import { effectivePickupStates } from '../../dispatcher/issuePickup.js';
import { buildSpendGoals } from '../../spendInsights.js';
import { buildTicketPage, NO_FEATURE } from '../../tickets/ticketList.js';
import { ticketOutcomes } from '../../tickets/outcomes.js';
import { watchLabelFor } from '../../watchLabels.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

const TicketQuery = z.object({
  watch: z
    .enum(['any', 'watched', 'unwatched'], {
      errorMap: () => ({ message: "watch must be 'any', 'watched' or 'unwatched'" }),
    })
    .default('any'),
  tracking: z
    .enum(['any', 'live', 'frozen'], { errorMap: () => ({ message: "tracking must be 'any', 'live' or 'frozen'" }) })
    .default('live'),
  state: z
    .string({ invalid_type_error: 'state must be a tracker state name' })
    .max(80, 'state must be at most 80 characters')
    .default('any'),
  feature: z
    .string({ invalid_type_error: 'feature must be a feature number, or none' })
    .max(20, 'feature must be at most 20 characters')
    .optional(),
  order: z
    .enum(['added', 'changed', 'cost'], { errorMap: () => ({ message: "order must be 'added', 'changed' or 'cost'" }) })
    .default('added'),
  cursor: z
    .string({ invalid_type_error: 'cursor must be a page cursor from an earlier response' })
    .max(64, 'cursor must be at most 64 characters')
    .optional(),
});

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, connector, config } = system;

  const TICKETS_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get(
    '/api/tickets',
    TICKETS_RATE_LIMIT,
    checked({ query: TicketQuery }, async ({ query }) => {
      const watchLabel = watchLabelFor(config.labelPrefix);
      const runs = store.floor.listIssueRuns();
      const { goals } = buildSpendGoals({
        agents: store.agents.listAgents(),
        localRuns: store.localRuns.listLocalRuns(),
        tasks: store.tasks.listTasks(),
        nodes: store.graph.listWorkNodes(),
        issues: store.world.getWorldBaseline()?.issues ?? [],
        runs,
      });
      const items = store.tickets.listTrackerItems();
      const featureSlots = store.tickets.ensureFeatureColors(
        items.flatMap((item) => (item.parent ? [item.parent.number] : [])),
      );
      const page = buildTicketPage({
        items,
        featureSlots,
        pickupStates:
          effectivePickupStates({
            pickupStates: config.issuePickupStates,
            inProgressState: config.issueInProgressState,
          }) ?? [],
        costs: new Map(goals.map((g) => [g.issueNumber, g.costUsd])),
        outcomes: ticketOutcomes({
          runs,
          conclusions: store.verdicts.listIssueConclusions(),
          deliveries: store.verdicts.listDeliveries(),
          shortfalls: store.verdicts.listShortfalls(),
          plans: store.plans.listPlans(),
          planParts: store.plans.listAllPlanParts(),
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

      const refUrls: Record<string, string> = {};
      for (const row of page.rows) {
        const url = connector.resolveRefUrl(issueOriginRef('root', row.number));
        if (url) refUrls[issueOriginRef('root', row.number)] = url;
      }

      return {
        ...page,
        anchorAt: system.tickets.anchorAt ?? '',
        backfilling: system.tickets.backfilling,
        refUrls,
      } satisfies TicketsPayload;
    }),
  );
}

function coarseAxes(
  tracking: TicketTrackingFilter,
  state: string,
): { tracking: TicketTrackingFilter; state: TicketStateFilter } {
  if (state === 'open') return { tracking: 'live', state: 'any' };
  if (state === 'closed') return { tracking: 'frozen', state: 'any' };
  return { tracking, state };
}

function parseFeature(raw: string | undefined): number | typeof NO_FEATURE | null {
  if (raw === undefined || raw === '') return null;
  if (raw === NO_FEATURE) return NO_FEATURE;
  const number = Number(raw);
  return Number.isInteger(number) && number > 0 ? number : null;
}
