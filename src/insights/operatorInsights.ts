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
  | 'agent-stopped'
  | 'pr-description-written';

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
  descriptionsWritten: readonly string[];
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

interface Tally {
  offered: number;
  settled: number;
  declined: number;
  openPastWindow: number;
  parkedMs: number;
  waits: number[];
}

function reduce(spec: RowSpec, window: ResolvedWindow, now: number, rateUsdPerMs: number): OperatorRow {
  const t = tally(spec, window, now);
  return {
    id: spec.id,
    kind: spec.kind,
    subject: spec.subject,
    label: spec.label,
    blurb: spec.blurb,
    offered: spec.countsOffers ? t.offered : null,
    settled: t.settled,
    declined: spec.declinable ? t.declined : null,
    openPastWindow: t.openPastWindow,
    medianAnswerMs: t.waits.length === 0 ? null : median(t.waits),
    parkedCostUsd: spec.parks && spec.stamps ? roundUsd(t.parkedMs * rateUsdPerMs) : null,
  };
}

function tally(spec: RowSpec, window: ResolvedWindow, now: number): Tally {
  const start = window.startMs;
  const t: Tally = { offered: 0, settled: 0, declined: 0, openPastWindow: 0, parkedMs: 0, waits: [] };

  for (const datum of spec.data) {
    const openedMs = Date.parse(datum.openedAt);
    if (Number.isNaN(openedMs)) continue;
    if (inWindow(window, openedMs)) t.offered += 1;
    if (datum.outcome === 'open' && start !== null && openedMs < start) t.openPastWindow += 1;

    const settledMs = parseSettled(datum.settledAt);
    const at = settledMs ?? openedMs;
    if (datum.outcome !== 'open' && inWindow(window, at)) {
      if (datum.outcome === 'answered') t.settled += 1;
      else t.declined += 1;
      if (settledMs !== null) t.waits.push(Math.max(0, settledMs - openedMs));
    }

    if (spec.parks && spec.stamps) t.parkedMs += parkedSpan(datum, openedMs, settledMs, start, now);
  }
  return t;
}

function parseSettled(settledAt: string | null): number | null {
  const raw = settledAt === null ? null : Date.parse(settledAt);
  return raw === null || Number.isNaN(raw) ? null : raw;
}

function parkedSpan(
  datum: Datum,
  openedMs: number,
  settledMs: number | null,
  start: number | null,
  now: number,
): number {
  const closedMs = settledMs ?? (datum.outcome === 'open' ? now : openedMs);
  const from = Math.max(openedMs, start ?? openedMs);
  return Math.max(0, Math.min(closedMs, now) - from);
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
      data: input.escalations.map(fromEscalation),
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
      data: input.obstacles.filter((o) => o.kind === 'obstacle').map(fromObstacle),
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
      data: fromUpgrade(input.upgrade),
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
      data: input.landings.map((l) => answered(l.createdAt, l.createdAt)),
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
      data: input.amendments.map(fromAmendment),
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
      data: input.plans.filter((p) => p.status === 'abandoned').map((p) => answered(p.createdAt, p.updatedAt)),
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
      data: input.checks.filter((c) => c.resultBy === 'operator' && c.resultAt !== null).map(fromCheck),
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
      data: input.conclusions.filter((c) => c.by === 'operator').map((c) => answered(c.createdAt, c.updatedAt)),
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
        .map((a) => answered(a.startedAt, a.endedAt)),
      declinable: false,
      countsOffers: false,
      parks: false,
      stamps: true,
    },
    descriptionAct(input),
  ];
}

function descriptionAct(input: OperatorInput): RowSpec {
  return {
    id: 'pr-description-written',
    kind: 'act',
    subject: 'pr-description',
    label: 'Writing a description',
    blurb: 'A person described a pull request themselves rather than taking the agent’s draft',
    data: input.descriptionsWritten.map((at) => answered(at, at)),
    declinable: false,
    countsOffers: false,
    parks: false,
    stamps: true,
  };
}

function answered(openedAt: string, settledAt: string | null): Datum {
  return { openedAt, settledAt, outcome: 'answered' };
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

function fromEscalation(e: Escalation): Datum {
  return {
    openedAt: e.createdAt,
    settledAt: e.answeredAt,
    outcome: e.answeredAt !== null ? 'answered' : e.status === 'dismissed' ? 'declined' : 'open',
  };
}

function fromObstacle(o: Obstacle): Datum {
  return {
    openedAt: o.createdAt,
    settledAt: null,
    outcome:
      o.state === 'owned' || o.state === 'resolved'
        ? 'answered'
        : o.endedBy === 'retired' || o.state === 'muted'
          ? 'declined'
          : 'open',
  };
}

function fromUpgrade(upgrade: UpgradeIntent): Datum[] {
  if (upgrade.requestedAt === null) return [];
  return [
    {
      openedAt: upgrade.requestedAt,
      settledAt: upgrade.state === 'applying' ? upgrade.requestedAt : null,
      outcome: upgrade.state === 'applying' ? 'answered' : 'open',
    },
  ];
}

function fromAmendment(a: PlanAmendment): Datum {
  return {
    openedAt: a.createdAt,
    settledAt: a.decidedAt,
    outcome: a.status === 'applied' ? 'answered' : a.status === 'declined' ? 'declined' : 'open',
  };
}

function fromCheck(c: ValidationCheck): Datum {
  return {
    openedAt: c.createdAt,
    settledAt: c.resultAt,
    outcome: c.state === 'failed' ? 'declined' : 'answered',
  };
}
