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
} from '../types.js';
import type { UsageSubject } from '../usage/events.js';
import { roundUsd } from './issueSpend.js';
import { inWindow, timelineSpan, windowView, type InsightsWindowView, type ResolvedWindow } from './insightsWindow.js';

// → docs/spec/18-observability.md

export type OperatorRowKind = 'ask' | 'act';

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

export interface OperatorRow {
  id: OperatorRowId;
  kind: OperatorRowKind;
  subject: UsageSubject;
  label: string;
  blurb: string;
  offered: number | null;
  settled: number;
  declined: number | null;
  openPastWindow: number;
  medianAnswerMs: number | null;
  parkedCostUsd: number | null;
}

export interface OperatorInsights {
  window: InsightsWindowView;
  asks: OperatorRow[];
  acts: OperatorRow[];
  fleetRateUsdPerHour: number;
}

const HOUR_MS = 60 * 60 * 1000;

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
  declinable: boolean;
  countsOffers: boolean;
  parks: boolean;
  stamps: boolean;
}

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
  costEvents: readonly CostEvent[];
  window: ResolvedWindow;
  now: number;
}

export function buildOperatorInsights(input: OperatorInput): OperatorInsights {
  const { window, now } = input;
  const first = input.costEvents[0];
  const earliest = first === undefined ? null : Date.parse(first.at);
  const span = timelineSpan(window, Number.isNaN(earliest ?? NaN) ? null : earliest);
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
    const at = settledMs ?? openedMs;
    if (datum.outcome !== 'open' && inWindow(window, at)) {
      if (datum.outcome === 'answered') settled += 1;
      else declined += 1;
      if (settledMs !== null) waits.push(Math.max(0, settledMs - openedMs));
    }

    if (spec.parks && spec.stamps) {
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
      data: input.proposals.filter((p) => p.kind === 'plan' && p.status !== 'withdrawn').map(fromProposal),
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
