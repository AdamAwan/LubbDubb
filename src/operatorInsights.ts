/**
 * The operator ledger: what the harness asked of a person, what they did about
 * it, and what the waiting cost.
 *
 * Every other reading the harness keeps is about the **fleet** — what it spent,
 * whether it worked, what it came back for. This is the one about the person
 * beside it, and it is derived for `src/spendInsights.ts`' reason exactly: no new
 * table, nothing stored, a fold over records that are already durable.
 *
 * ## Two halves, and they are two different questions
 *
 * An **ask** is the harness stopping and waiting for a person; an **act** is a
 * person reaching in when nothing asked them to. Folded together they would
 * produce one meaningless "operator activity" figure, and they want opposite
 * readings: an ask is judged by whether it was answered and what waiting for it
 * cost, an act by whether it happened at all — because an act nobody ever
 * performs is a control nobody needs.
 *
 * **A decline is not a failure.** An operator declining an ask is the harness
 * having asked for the wrong thing, and the two columns stay apart for the reason
 * `src/reliabilityInsights.ts` keeps `killed` out of `completionRate`: folded
 * together, a well-steered fleet and a broken one draw the same shape.
 *
 * ## One sweep over the settled records, never a call at each settling route
 *
 * `src/pets/scan.ts`' `collectActions` states the argument and this reading takes
 * it whole: a record written where the act happens stops counting, silently, the
 * day a second path settles the same thing. So every row here reads a table, and
 * a row whose table cannot answer says so with `null` rather than with a zero —
 * `src/mcpInsights.ts`' doctrine, over a different actor: **a count of zero is not
 * a finding**.
 *
 * ## What is deliberately absent
 *
 * Three acts the harness offers leave no record at all, so there is no row for
 * them and inventing one would be a permanent zero with nothing saying why:
 * **un-watching a goal** is the removal of a label that nothing writes back
 * (`src/watchLabels.ts`), **changing configuration** is a file write with no row
 * behind it, and **sending a plan back** flips a status and settles what hung off
 * it without recording that a person did. Each becomes a row on the day a record
 * exists, and until then the registry carries their copy and marks them `ui`.
 *
 * → `docs/spec/33-usage-metrics.md#the-operator-ledger`
 */

import type {
  Agent,
  Escalation,
  HumanTask,
  IssueConclusion,
  Obstacle,
  Plan,
  PlanAmendment,
  Proposal,
  StackLanding,
  UpgradeIntent,
  UsageEvent as CostEvent,
  ValidationCheck,
} from './types.js';
import type { UsageSubject } from './usage/events.js';
import { roundUsd } from './issueSpend.js';
import { inWindow, timelineSpan, windowView, type InsightsWindowView, type ResolvedWindow } from './insightsWindow.js';

/** Which half a row belongs to — the two questions, kept apart on the wire too. */
export type OperatorRowKind = 'ask' | 'act';

/**
 * The rows, named once. Ids rather than `subject.verb` keys because two rows can
 * share a cell honestly — the validation *bench* and one validation *check* are
 * both `validation` settled by a person, and they are different objects with
 * different records behind them.
 */
export type OperatorRowId =
  | 'escalation'
  | 'human-task'
  | 'plan-approval'
  | 'obstacle-ownership'
  | 'validation-bench'
  | 'upgrade'
  | 'stack-landing'
  | 'plan-amendment'
  | 'plan-abandoned'
  | 'validation-check'
  | 'goal-retired'
  | 'agent-stopped';

/**
 * One row of the ledger.
 *
 * `null` never means zero. It means the record behind this row cannot answer that
 * question — an obstacle carries no stamp for the moment it started asking, a
 * landing records only the click and never the offer — and a panel drawing a zero
 * there would be manufacturing a finding out of a missing column.
 */
export interface OperatorRow {
  id: OperatorRowId;
  kind: OperatorRowKind;
  /** The registry's subject, so a panel and the digest group the same way. */
  subject: UsageSubject;
  label: string;
  blurb: string;
  /** Asked (an ask) or available (an act), inside the window. Null when unrecorded. */
  offered: number | null;
  /** Answered, or done, inside the window. */
  settled: number;
  /** Declined inside the window. Null when the record cannot tell a decline from a settle. */
  declined: number | null;
  /** Still open now, and opened before this window did — outstanding longer than the whole span. */
  openPastWindow: number;
  /** Median wait from the ask to the answer, in ms. Null when nothing settled, or nothing is stamped. */
  medianAnswerMs: number | null;
  /**
   * What the fleet did not do while it waited. Null on an act — nothing was
   * parked — and on an ask whose record carries no stamp to measure a wait from.
   */
  parkedCostUsd: number | null;
}

export interface OperatorInsights {
  window: InsightsWindowView;
  asks: OperatorRow[];
  acts: OperatorRow[];
  /**
   * The fleet's own burn over this window, in dollars per hour, and what
   * {@link OperatorRow.parkedCostUsd} is priced at.
   *
   * Shipped rather than left implicit because a parked cost is a *product* of two
   * figures and a reader deciding to act on one is entitled to both: an hour of
   * waiting is worth what this fleet actually spends in an hour, and on a quiet
   * week that is a small number for reasons that have nothing to do with the ask.
   */
  fleetRateUsdPerHour: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * One thing that was put to a person, reduced to what every figure above needs.
 *
 * `settledAt` is null on a record that settles without a stamp — an escalation
 * dismissal, an obstacle taken on — and the reducer answers `medianAnswerMs` and
 * `parkedCostUsd` with `null` for the whole row rather than guessing at a
 * duration from `updatedAt`, which moves under several of these rows for reasons
 * that are not a person acting.
 */
interface Datum {
  openedAt: string;
  settledAt: string | null;
  outcome: 'answered' | 'declined' | 'open';
}

interface RowSpec {
  id: OperatorRowId;
  kind: OperatorRowKind;
  subject: UsageSubject;
  label: string;
  blurb: string;
  data: Datum[];
  /** False when the record cannot tell a decline from a settle — the column then ships null. */
  declinable: boolean;
  /** False when nothing counts an offer: an act's population is usually unrecorded. */
  countsOffers: boolean;
  /** Whether waiting on this holds the fleet up. False on every act. */
  parks: boolean;
  /**
   * Whether the record stamps its settles. False is a property of the *table*, not
   * of the rows in it: an obstacle's `updated_at` moves on every sighting, so
   * there is no instant to measure a wait to, and the row ships `null` for both
   * durations rather than a figure derived from a column that means something
   * else.
   */
  stamps: boolean;
}

/** Everything the fold reads. All of it already durable, none of it new. */
export interface OperatorInput {
  escalations: readonly Escalation[];
  proposals: readonly Proposal[];
  humanTasks: readonly HumanTask[];
  obstacles: readonly Obstacle[];
  upgrade: UpgradeIntent;
  landings: readonly StackLanding[];
  plans: readonly Plan[];
  amendments: readonly PlanAmendment[];
  checks: readonly ValidationCheck[];
  conclusions: readonly IssueConclusion[];
  agents: readonly Agent[];
  /** The fleet's dated cost deltas over the window — the price of an hour of waiting. */
  costEvents: readonly CostEvent[];
  window: ResolvedWindow;
  now: number;
}

export function buildOperatorInsights(input: OperatorInput): OperatorInsights {
  const { window, now } = input;
  const first = input.costEvents[0];
  const earliest = first === undefined ? null : Date.parse(first.at);
  const span = timelineSpan(window, Number.isNaN(earliest ?? NaN) ? null : earliest);
  // The rate is measured over the stretch the window actually covers, which for
  // `all` is the fleet's own history rather than a span guessed at here — the same
  // stretch `timelineSpan` cuts, so the number under the graph and the number in
  // this column describe one period.
  const elapsedMs = Math.max(1, now - (window.startMs ?? span.startMs));
  const spent = input.costEvents.reduce((sum, e) => sum + e.costUsd, 0);
  const rateUsdPerMs = spent / elapsedMs;

  const specs = [...askSpecs(input), ...actSpecs(input)];
  const rows = specs.map((spec) => reduce(spec, window, now, rateUsdPerMs));
  return {
    window: windowView(window, span),
    asks: rows.filter((r) => r.kind === 'ask'),
    acts: rows.filter((r) => r.kind === 'act'),
    fleetRateUsdPerHour: roundUsd(rateUsdPerMs * HOUR_MS),
  };
}

/**
 * The figures, from one shape of datum.
 *
 * Every count but {@link OperatorRow.openPastWindow} is measured *inside* the
 * window, and that one is measured against it: "still open, and it was already
 * open when this window began" is the only honest way to say outstanding-too-long
 * with one control serving six spans.
 */
function reduce(spec: RowSpec, window: ResolvedWindow, now: number, rateUsdPerMs: number): OperatorRow {
  const start = window.startMs;
  let offered = 0;
  let settled = 0;
  let declined = 0;
  let openPastWindow = 0;
  let parkedMs = 0;
  const waits: number[] = [];

  for (const datum of spec.data) {
    const openedMs = Date.parse(datum.openedAt);
    if (Number.isNaN(openedMs)) continue;
    if (inWindow(window, openedMs)) offered += 1;
    if (datum.outcome === 'open' && start !== null && openedMs < start) openPastWindow += 1;

    const raw = datum.settledAt === null ? null : Date.parse(datum.settledAt);
    const settledMs = raw === null || Number.isNaN(raw) ? null : raw;
    // A settle with no stamp is counted where it was raised: the act happened, and
    // the alternative is a column that reads zero on a record that has one.
    const at = settledMs ?? openedMs;
    if (datum.outcome !== 'open' && inWindow(window, at)) {
      if (datum.outcome === 'answered') settled += 1;
      else declined += 1;
      if (settledMs !== null) waits.push(Math.max(0, settledMs - openedMs));
    }

    if (spec.parks && spec.stamps) {
      // A settled row with no stamp closes where it opened rather than at `now`:
      // the record cannot say how long it held the fleet, so it contributes
      // nothing to the price instead of contributing the whole window.
      const closedMs = settledMs ?? (datum.outcome === 'open' ? now : openedMs);
      const from = Math.max(openedMs, start ?? openedMs);
      parkedMs += Math.max(0, Math.min(closedMs, now) - from);
    }
  }

  return {
    id: spec.id,
    kind: spec.kind,
    subject: spec.subject,
    label: spec.label,
    blurb: spec.blurb,
    offered: spec.countsOffers ? offered : null,
    settled,
    declined: spec.declinable ? declined : null,
    openPastWindow,
    medianAnswerMs: waits.length === 0 ? null : median(waits),
    parkedCostUsd: spec.parks && spec.stamps ? roundUsd(parkedMs * rateUsdPerMs) : null,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const high = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? high : Math.round(((sorted[mid - 1] ?? 0) + high) / 2);
}

function askSpecs(input: OperatorInput): RowSpec[] {
  return [
    {
      id: 'escalation',
      kind: 'ask',
      subject: 'escalation',
      label: 'Escalation',
      blurb: 'The harness stopped and put a question to a person',
      // A dismissal carries no stamp of its own, so it is counted where it was
      // raised and the wait it did not record is left out of the median.
      data: input.escalations.map(
        (e): Datum => ({
          openedAt: e.createdAt,
          settledAt: e.answeredAt,
          outcome: e.answeredAt !== null ? 'answered' : e.status === 'dismissed' ? 'declined' : 'open',
        }),
      ),
      declinable: true,
      countsOffers: true,
      parks: true,
      stamps: true,
    },
    {
      id: 'human-task',
      kind: 'ask',
      subject: 'human-task',
      label: 'Bench item',
      blurb: 'Work only a person can do, filed by an agent or by an operator',
      data: input.humanTasks.filter((t) => t.kind === 'ask').map(fromHumanTask),
      declinable: true,
      countsOffers: true,
      parks: true,
      stamps: true,
    },
    {
      id: 'plan-approval',
      kind: 'ask',
      subject: 'plan',
      label: 'Plan approval',
      blurb: 'A decomposition held off the fleet until somebody released it',
      // The `plans` table is the wrong record here and it is worth saying why: it
      // carries no stamp for entering or leaving `awaiting_approval`, and
      // `updatedAt` moves afterwards for reasons that are the fleet's. The
      // proposal *is* the ask, and it is stamped on both ends.
      data: input.proposals.filter((p) => p.kind === 'plan').map(fromProposal),
      declinable: true,
      countsOffers: true,
      parks: true,
      stamps: true,
    },
    {
      id: 'obstacle-ownership',
      kind: 'ask',
      subject: 'obstacle',
      label: 'Obstacle ownership',
      blurb: 'Something in the fleet’s way, waiting for somebody to own it',
      // No stamp on either settle: `updatedAt` moves on every sighting, so the row
      // reports counts and refuses a duration rather than reporting a wrong one.
      data: input.obstacles
        .filter((o) => o.kind === 'obstacle')
        .map(
          (o): Datum => ({
            openedAt: o.createdAt,
            settledAt: null,
            outcome:
              o.state === 'owned' || o.state === 'resolved'
                ? 'answered'
                : o.endedBy === 'retired' || o.state === 'muted'
                  ? 'declined'
                  : 'open',
          }),
        ),
      declinable: true,
      countsOffers: true,
      parks: true,
      stamps: false,
    },
    {
      id: 'validation-bench',
      kind: 'ask',
      subject: 'validation',
      label: 'Validation bench',
      blurb: 'A delivered goal’s checks, held open until they are run',
      data: input.humanTasks.filter((t) => t.kind === 'validate').map(fromHumanTask),
      declinable: true,
      countsOffers: true,
      parks: true,
      stamps: true,
    },
    {
      id: 'upgrade',
      kind: 'ask',
      subject: 'upgrade',
      label: 'Upgrade',
      blurb: 'A newer build of the harness itself, waiting to be taken',
      // One mutable row and no history, so this can only ever describe the intent
      // that stands: at most one datum, and a declined upgrade leaves nothing.
      data:
        input.upgrade.requestedAt === null
          ? []
          : [
              {
                openedAt: input.upgrade.requestedAt,
                settledAt: input.upgrade.state === 'applying' ? input.upgrade.requestedAt : null,
                outcome: input.upgrade.state === 'applying' ? 'answered' : 'open',
              },
            ],
      declinable: false,
      countsOffers: true,
      parks: true,
      stamps: true,
    },
  ];
}

function actSpecs(input: OperatorInput): RowSpec[] {
  return [
    {
      id: 'stack-landing',
      kind: 'act',
      subject: 'pr',
      label: 'Authorising a landing',
      blurb: 'A whole chain cleared to land in one click',
      // An act rather than an ask: the row exists only because somebody clicked,
      // and nothing records that a landable stack was ever put in front of them.
      data: input.landings.map((l): Datum => ({ openedAt: l.createdAt, settledAt: l.createdAt, outcome: 'answered' })),
      declinable: false,
      countsOffers: false,
      parks: false,
      stamps: true,
    },
    {
      id: 'plan-amendment',
      kind: 'act',
      subject: 'plan',
      label: 'Amending a plan',
      blurb: 'A correction to a plan that was already running',
      data: input.amendments.map(
        (a): Datum => ({
          openedAt: a.createdAt,
          settledAt: a.decidedAt,
          outcome: a.status === 'applied' ? 'answered' : a.status === 'declined' ? 'declined' : 'open',
        }),
      ),
      declinable: true,
      countsOffers: true,
      parks: false,
      stamps: true,
    },
    {
      id: 'plan-abandoned',
      kind: 'act',
      subject: 'plan',
      label: 'Abandoning a plan',
      blurb: 'The plan was dropped and nothing replaced it',
      data: input.plans
        .filter((p) => p.status === 'abandoned')
        .map((p): Datum => ({ openedAt: p.createdAt, settledAt: p.updatedAt, outcome: 'answered' })),
      declinable: false,
      countsOffers: false,
      parks: false,
      stamps: true,
    },
    {
      id: 'validation-check',
      kind: 'act',
      subject: 'validation',
      label: 'Settling a check',
      blurb: 'A person ran the procedure and recorded what it did',
      // `resultBy` is the whole of the filter: an agent the operator handed a check
      // to, and a desktop session, both write results here and neither is a person
      // working through the checklist. → docs/spec/20-validation.md
      data: input.checks
        .filter((c) => c.resultBy === 'operator' && c.resultAt !== null)
        .map(
          (c): Datum => ({
            openedAt: c.createdAt,
            settledAt: c.resultAt,
            outcome: c.state === 'failed' ? 'declined' : 'answered',
          }),
        ),
      declinable: true,
      countsOffers: false,
      parks: false,
      stamps: true,
    },
    {
      id: 'goal-retired',
      kind: 'act',
      subject: 'goal',
      label: 'Concluding a goal',
      blurb: 'The operator’s own verdict on whether a goal is finished',
      data: input.conclusions
        .filter((c) => c.by === 'operator')
        .map((c): Datum => ({ openedAt: c.createdAt, settledAt: c.updatedAt, outcome: 'answered' })),
      declinable: false,
      countsOffers: false,
      parks: false,
      stamps: true,
    },
    {
      id: 'agent-stopped',
      kind: 'act',
      subject: 'agent',
      label: 'Stopping an agent',
      blurb: 'A run halted by a person rather than by its own end',
      // The same two outcomes `src/reliabilityInsights.ts` keeps out of the
      // completion rate, read here as the act they are.
      data: input.agents
        .filter((a) => a.status === 'killed' || a.status === 'interrupted')
        .map((a): Datum => ({ openedAt: a.startedAt, settledAt: a.endedAt, outcome: 'answered' })),
      declinable: false,
      countsOffers: false,
      parks: false,
      stamps: true,
    },
  ];
}

function fromHumanTask(task: HumanTask): Datum {
  return {
    openedAt: task.createdAt,
    settledAt: task.resolvedAt,
    outcome: task.status === 'done' ? 'answered' : task.status === 'declined' ? 'declined' : 'open',
  };
}

function fromProposal(proposal: Proposal): Datum {
  return {
    openedAt: proposal.createdAt,
    settledAt: proposal.decidedAt,
    outcome: proposal.status === 'accepted' ? 'answered' : proposal.status === 'rejected' ? 'declined' : 'open',
  };
}
