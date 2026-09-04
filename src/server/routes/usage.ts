import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UsagePayload } from '../../wire.js';
import type { SurfaceReachInput } from '../../types.js';
import { buildOperatorInsights } from '../../operatorInsights.js';
import { buildSurfaceReach } from '../../surfaceReachInsights.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insightsWindow.js';
import { PLACE_KEYS, USAGE_SUBJECTS, VERBS_BY_SUBJECT } from '../../usage/events.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The operator ledger and the reach beside it, behind the Insights Usage tab —
 * and the one write the cockpit makes about itself.
 *
 * A route of its own rather than a field on `/api/spend`, for `/api/mcp/usage`'s
 * reason: it sweeps every settled-record table the harness keeps about a person,
 * and nothing here is needed to draw anything on the top bar.
 *
 * **The window is asked for once and passed down**, so the stretch the rows are
 * counted over and the stretch the parked cost is priced over are one value. Two
 * `since`s would put a wait measured over a fortnight against a burn rate
 * measured over a day, and the product of the two would be a dollar figure about
 * nothing. The reach fold takes the same one, because the pairing the two halves
 * exist for is only a pairing if both describe the same stretch.
 *
 * Every read is unbounded for `src/pets/scan.ts`' reason: these tables are
 * hundreds of rows on a long-lived deployment, the cut is on a different column
 * per source, and a `LIMIT` here would not be a boundary but a leak — it would
 * silently stop counting for the deployments that had done the most.
 *
 * → [16](../../../docs/spec/16-http-api.md),
 *   [33](../../../docs/spec/33-usage-metrics.md#the-operator-ledger)
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/usage',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.readRateLimits());
      const since = sinceOrEpoch(window.since);
      const plans = store.listPlans();
      return {
        insights: buildOperatorInsights({
          escalations: store.listEscalations(),
          proposals: store.listProposals(),
          humanTasks: store.listHumanTasks(ALL),
          obstacles: store.listObstacles(),
          upgrade: store.readUpgradeIntent(),
          landings: store.listStackLandings(ALL),
          plans,
          amendments: plans.flatMap((plan) => store.listPlanAmendments(plan.id)),
          checks: store.listAllValidationChecks(),
          conclusions: store.listIssueConclusions(),
          agents: store.listAgents(),
          // The agents' own dated deltas, not `listCostDeltasSince`: a local run is
          // the operator's machine rather than the fleet, and the rate this prices
          // a wait at is what the *fleet* would have spent in that hour.
          costEvents: store.listUsageEventsSince(since),
          window,
          now,
        }),
        reach: buildSurfaceReach({
          rows: store.listSurfaceReachSince(since),
          // Unwindowed on purpose, and it is the one read here that is: it is what
          // tells `never-linked` from `linked-never-visited`, and scoped to the
          // window that verdict would flip on the window control alone.
          everLinked: store.linkedSubjectsEverReached(),
          window,
        }),
      } satisfies UsagePayload;
    }),
  );

  /**
   * The cockpit's batch of `ui` events — the only writer of `surface_reach`, and
   * the only route in the harness whose failure is deliberately of no
   * consequence.
   *
   * **It answers `{ ok: true }` and nothing else.** The client is fire-and-forget
   * and discards the response; a body carrying counts would be a reading the
   * cockpit could act on, and nothing about telemetry may change what a control
   * does.
   *
   * **A malformed row refuses the batch with a 400 rather than being dropped.**
   * The alternative is a cockpit shipping a subject the registry does not have and
   * a server quietly recording nothing — the permanent silent zero this whole
   * reading exists to make impossible. The refusal is a returned value, per
   * [16](../../../docs/spec/16-http-api.md#request-validation), and the client
   * never sees it because it never looks.
   *
   * The batch is capped at {@link BATCH_MAX} rows. That is a bound on one request
   * and not on what may be recorded: the cockpit flushes on a clock, so a longer
   * session is more flushes rather than a larger one.
   */
  app.post(
    '/api/usage/events',
    checked({ body: UsageBatchBody }, async ({ body }) => {
      // Called for its effect; the count is discarded. A telemetry write that can
      // turn a working navigation into a failed one is worse than no telemetry.
      store.recordSurfaceReach(body.events as SurfaceReachInput[]);
      store.pruneSurfaceReach();
      return { ok: true };
    }),
  );
}

/** `collectActions`' bound, and it is a bound rather than a page. */
const ALL = 100_000;

/**
 * How many rows one flush may carry.
 *
 * Generous rather than tight: the cost of refusing a flush is a lost reading, and
 * the cost of accepting a large one is a single transaction of five short columns.
 */
const BATCH_MAX = 500;

/**
 * One thing a person did, as the wire carries it — and the schema *is* the privacy
 * boundary, restated where the bytes arrive.
 *
 * There is nowhere here to put a ref, an id, a title or a note, so a cockpit that
 * grew the habit of sending one would be refused rather than recorded. Both keys
 * are closed vocabularies checked against the registry itself, so a subject or a
 * verb the harness does not have cannot be written — which is what keeps the
 * digest's cross-fleet comparability a property of the data rather than of a
 * convention.
 *
 * **`at` is not on the wire.** The store stamps the batch as it lands, so a client
 * clock cannot write the future into a window fold, and there is one fewer field
 * for an identifier to hide in. A flush is coalesced over a few seconds, which is
 * well under the resolution of every window this is read at.
 */
const UsageEventRow = z
  .object({
    subject: z.enum(USAGE_SUBJECTS as [string, ...string[]], {
      errorMap: () => ({ message: 'subject must be one of the registry’s subjects' }),
    }),
    verb: z.string({ required_error: 'verb must be one the subject offers' }),
    place: z.enum(PLACE_KEYS as unknown as [string, ...string[]], {
      errorMap: () => ({ message: `place must be one of ${PLACE_KEYS.join(', ')}` }),
    }),
    arrival: z.enum(['linked', 'direct'], { errorMap: () => ({ message: 'arrival must be linked or direct' }) }),
  })
  // The matrix, checked as a pair rather than as two enums: `plan.defer` is a cell
  // the registry leaves empty, and two independently valid halves are exactly how
  // a combination that means nothing gets written down and then grouped by.
  .refine(
    (row) => (VERBS_BY_SUBJECT[row.subject as keyof typeof VERBS_BY_SUBJECT] as readonly string[]).includes(row.verb),
    {
      message: 'verb must be one the subject offers',
    },
  );

const UsageBatchBody = z.object({
  events: z
    .array(UsageEventRow, { required_error: 'events must be an array of usage rows' })
    .max(BATCH_MAX, { message: `events must hold at most ${BATCH_MAX} rows` }),
});
