import { issueOriginRef, issueSubtreeNumber } from '../issueOrigins.js';
import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { EscalationSpan, HumanTask, Issue, IssueRun } from '../types.js';
import { issuePickupStatus, issueWatchGateReason, type IssuePickupContext } from '../dispatcher/issuePickup.js';
import { appraisalHold } from '../intake/appraisal.js';
import { liveParts } from '../plans/parts.js';

// → docs/spec/25-supply.md

export type SupplyState = 'healthy' | 'thin' | 'dry' | 'starved' | 'unknown';

export interface RunwayPolicy {
  enabled: boolean;
  warnHours: number;
  clearHours: number;
  minimumRuns: number;
}

export const DEFAULT_RUNWAY: RunwayPolicy = {
  enabled: true,
  warnHours: 1,
  clearHours: 3,
  minimumRuns: 5,
};

export function validateRunwayPolicy(policy: RunwayPolicy): void {
  if (typeof policy.warnHours !== 'number' || !(policy.warnHours > 0) || !Number.isFinite(policy.warnHours))
    throw new Error(
      `Refusing to start: runway.warnHours is ${JSON.stringify(policy.warnHours)}, and must be a number of hours ` +
        `above 0 — the runway below which the queue is worth an operator's attention.`,
    );
  if (typeof policy.clearHours !== 'number' || !(policy.clearHours > policy.warnHours))
    throw new Error(
      `Refusing to start: runway.clearHours is ${JSON.stringify(policy.clearHours)}, and must be a number of hours ` +
        `above runway.warnHours (${policy.warnHours}) — at or below it the notice flaps between filed and settled ` +
        `every time one goal finishes.`,
    );
  if (!Number.isInteger(policy.minimumRuns) || policy.minimumRuns < 1)
    throw new Error(
      `Refusing to start: runway.minimumRuns is ${JSON.stringify(policy.minimumRuns)}, and must be a whole number ` +
        `of completed goals (1 or more) before their median lead time is trusted.`,
    );
}

interface LatentSupply {
  plans: number;
  profiles: number;
  escalated: number;
  parts: number;
}

export interface RunwayReading {
  state: SupplyState;
  runwayMinutes: number | null;
  inflight: number;
  queued: number;
  reservoir: number;
  reservoirContainers: number;
  held: number;
  latent: LatentSupply;
  debt: number;
  medianLeadMinutes: number | null;
  medianHeldMinutes: number | null;
  completedRuns: number;
  unmeasuredRuns: number;
  idleSlots: number;
  headline: string;
  detail: string;
}

export interface RunwayInput {
  policy: RunwayPolicy;
  issues: readonly Issue[];
  pickup: IssuePickupContext;
  runs: readonly IssueRun[];
  humanTasks: readonly HumanTask[];
  escalations: readonly EscalationSpan[];
  cap: number;
  standing: boolean;
}

const INFLIGHT = new Set(['active', 'has_pr', 'planning']);
const QUEUED = new Set(['eligible', 'blocked', 'cooldown']);
const HELD = new Set(['escalated', 'delivered', 'retained']);

export function readRunway(input: RunwayInput): RunwayReading {
  let inflight = 0;
  let queued = 0;
  let reservoir = 0;
  let reservoirContainers = 0;
  let held = 0;
  let escalated = 0;

  const appraisals = input.pickup.appraisals ?? [];
  const plans = input.pickup.plans ?? [];
  const planParts = input.pickup.planParts ?? [];

  for (const issue of input.issues) {
    const { status } = issuePickupStatus(issue, input.pickup);
    if (INFLIGHT.has(status)) inflight += 1;
    else if (QUEUED.has(status)) queued += 1;
    else if (status === 'appraisal') {
      const hold = appraisalHold(
        appraisals.find((a) => a.originRef === issueOriginRef('root', issue.number)) ?? null,
        issue,
      );
      if (hold === null) queued += 1;
      else held += 1;
    } else if (HELD.has(status)) {
      held += 1;
      if (status === 'escalated') escalated += 1;
    } else if (status === 'unwatched') reservoir += 1;
    else if (status === 'container' && issueWatchGateReason(issue, input.pickup.policy) !== null) {
      reservoirContainers += 1;
    }
  }

  const {
    lead: medianLeadMinutes,
    held: medianHeldMinutes,
    measured: completedRuns,
    unmeasured: unmeasuredRuns,
  } = medianLead(input.runs, input.policy.minimumRuns, humanHolds(input));
  const supply = inflight + queued;
  const cap = Math.max(1, input.cap);
  const idleSlots = input.pickup.paused ? 0 : Math.max(0, input.pickup.headroom);
  const runwayMinutes =
    queued === 0 || medianLeadMinutes === null ? null : Math.round((supply * medianLeadMinutes) / cap);

  const latent: LatentSupply = {
    plans: plans.filter((p) => p.status === 'awaiting_approval').length,
    profiles: appraisals.filter((a) => a.proposedProfile !== null && a.profileAnsweredAt === null).length,
    escalated,
    parts: plans
      .filter((p) => p.status === 'awaiting_approval')
      .reduce((n, p) => n + liveParts(planParts.filter((part) => part.planId === p.id)).length, 0),
  };
  const debt = input.humanTasks.filter((t) => t.status === 'open' && t.kind !== 'supply').length;

  const state = resolveState({
    policy: input.policy,
    paused: input.pickup.paused,
    queued,
    idleSlots,
    runwayMinutes,
    medianLeadMinutes,
    standing: input.standing,
  });

  const reading: Omit<RunwayReading, 'headline' | 'detail'> = {
    state,
    runwayMinutes,
    inflight,
    queued,
    reservoir,
    reservoirContainers,
    held,
    latent,
    debt,
    medianLeadMinutes,
    medianHeldMinutes,
    completedRuns,
    unmeasuredRuns,
    idleSlots,
  };
  return { ...reading, ...say(reading, cap) };
}

function resolveState(input: {
  policy: RunwayPolicy;
  paused: boolean;
  queued: number;
  idleSlots: number;
  runwayMinutes: number | null;
  medianLeadMinutes: number | null;
  standing: boolean;
}): SupplyState {
  if (!input.paused && input.queued === 0 && input.idleSlots > 0) return 'starved';
  if (input.queued === 0) return 'dry';
  if (input.runwayMinutes === null || input.medianLeadMinutes === null) return 'unknown';
  const threshold = (input.standing ? input.policy.clearHours : input.policy.warnHours) * 60;
  return input.runwayMinutes < threshold ? 'thin' : 'healthy';
}

function medianLead(
  runs: readonly IssueRun[],
  minimum: number,
  holds: Map<string, Hold[]>,
): { lead: number | null; held: number | null; measured: number; unmeasured: number } {
  const done = runs.filter((r) => r.completedAt !== null);
  const completed = done.length;
  const pairs = done
    .map((r) => {
      const from = Date.parse(r.startedAt);
      const to = Date.parse(r.completedAt as string);
      const held = heldWithin(holds.get(r.originRef) ?? [], from, to);
      return { work: to - from - held, held };
    })
    .filter((p) => Number.isFinite(p.work) && p.work > 0);
  const measured = pairs.length;
  const unmeasured = completed - measured;
  if (measured < minimum) return { lead: null, held: null, measured, unmeasured };
  return {
    lead: medianMinutes(pairs.map((p) => p.work)),
    held: medianMinutes(pairs.map((p) => p.held)),
    measured,
    unmeasured,
  };
}

function medianMinutes(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ms =
    sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(ms / 60_000);
}

interface Hold {
  from: number;
  to: number | null;
}

function goalOf(ref: string | null): string | null {
  const number = issueSubtreeNumber(ref);
  return number === null ? null : issueOriginRef('root', number);
}

function benchRowHolds(t: HumanTask): boolean {
  if (t.kind === 'close_out' || t.kind === 'validate') return true;
  return t.kind === 'ask' && t.partId !== null;
}

function humanHolds(input: RunwayInput): Map<string, Hold[]> {
  const held = new Map<string, Hold[]>();
  const add = (ref: string | null, from: string, to: string | null): void => {
    const goal = goalOf(ref);
    const start = Date.parse(from);
    if (goal === null || !Number.isFinite(start)) return;
    const end = to === null ? NaN : Date.parse(to);
    const list = held.get(goal) ?? [];
    list.push({ from: start, to: Number.isFinite(end) ? end : null });
    held.set(goal, list);
  };

  for (const t of input.humanTasks) if (benchRowHolds(t)) add(t.originRef, t.createdAt, t.resolvedAt);
  const issuesByRef = new Map(input.issues.map((i) => [issueOriginRef('root', i.number), i]));
  for (const a of input.pickup.appraisals ?? []) {
    if (a.profileAnsweredAt === null) continue;
    const issue = issuesByRef.get(a.originRef);
    if (!issue) continue;
    if (appraisalHold({ ...a, profileAnsweredAt: null }, issue) === null) continue;
    add(a.originRef, a.decidedAt, a.profileAnsweredAt);
  }
  for (const d of input.pickup.deliveries ?? []) add(d.originRef, d.decidedAt, null);
  const byPr = prGoals(input.runs);
  for (const e of input.escalations) {
    if (e.answeredAt === null && !e.open) continue;
    const ref = goalOf(e.originRef) ?? (e.prNumber === null ? null : (byPr.get(e.prNumber) ?? null));
    if (ref !== null) add(ref, e.createdAt, e.answeredAt);
  }
  return held;
}

function prGoals(runs: readonly IssueRun[]): Map<number, string> {
  const byPr = new Map<number, string>();
  for (const r of runs) if (r.linkedPrNumber !== null) byPr.set(r.linkedPrNumber, r.originRef);
  return byPr;
}

function heldWithin(holds: readonly Hold[], from: number, to: number): number {
  const spans = holds
    .map((h) => ({ from: Math.max(h.from, from), to: Math.min(h.to ?? to, to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  let total = 0;
  let cursor = -Infinity;
  for (const s of spans) {
    const start = Math.max(s.from, cursor);
    if (s.to > start) {
      total += s.to - start;
      cursor = s.to;
    }
  }
  return total;
}

function humanMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function reservoirClause(reading: Omit<RunwayReading, 'headline' | 'detail'>): string | null {
  if (reading.reservoir === 0) return null;
  const base = `${reading.reservoir} open issue${reading.reservoir === 1 ? '' : 's'} nobody has watched`;
  return reading.reservoirContainers === 0
    ? base
    : `${base}, under ${reading.reservoirContainers} unwatched container${reading.reservoirContainers === 1 ? '' : 's'} whose watch would cascade`;
}

function say(reading: Omit<RunwayReading, 'headline' | 'detail'>, cap: number): { headline: string; detail: string } {
  const latent = latentClause(reading.latent);
  const reservoir = reservoirClause(reading);
  const debt =
    reading.debt === 0 ? null : `${reading.debt} other row${reading.debt === 1 ? '' : 's'} on the bench are open.`;

  if (reading.state === 'starved') {
    const headline = latent ? 'The fleet is waiting on you, not on work' : 'Slots are idle with nothing to take';
    return {
      headline,
      detail: [
        `Nothing is eligible for pickup and ${reading.idleSlots} of ${cap} slot${cap === 1 ? '' : 's'} ` +
          `${reading.idleSlots === 1 ? 'is' : 'are'} empty.`,
        latent,
        reservoir === null ? null : `${capitalise(reservoir)}.`,
        debt,
      ]
        .filter((s): s is string => s !== null)
        .join(' '),
    };
  }

  if (reading.state === 'dry') {
    return {
      headline: latent ? 'The fleet is waiting on you, not on work' : 'Nothing is queued behind the fleet',
      detail: [
        `${reading.inflight} goal${reading.inflight === 1 ? ' is' : 's are'} in flight and nothing is waiting behind ` +
          `them — the next one to finish leaves a slot with nothing to take it.`,
        latent,
        reservoir === null ? null : `${capitalise(reservoir)}.`,
      ]
        .filter((s): s is string => s !== null)
        .join(' '),
    };
  }

  if (reading.state === 'thin' && reading.runwayMinutes !== null) {
    return {
      headline: 'The queue is thinning',
      detail: [
        `${reading.inflight} in flight, ${reading.queued} waiting. At ${cap} slot${cap === 1 ? '' : 's'} and a ` +
          `${humanMinutes(reading.medianLeadMinutes ?? 0)} median goal of fleet time, that is ` +
          `${humanMinutes(reading.runwayMinutes)} before the fleet runs out.`,
        heldClause(reading),
        reservoir === null ? null : `${capitalise(reservoir)}.`,
        latent,
      ]
        .filter((s): s is string => s !== null)
        .join(' '),
    };
  }

  if (reading.state === 'unknown') {
    return {
      headline: 'Not enough history for a runway yet',
      detail:
        (reading.unmeasuredRuns > 0
          ? `${reading.completedRuns} of ${reading.completedRuns + reading.unmeasuredRuns} completed goals left ` +
            `fleet time to measure; a median lead time is taken over more. `
          : `${reading.completedRuns} goal${reading.completedRuns === 1 ? ' has' : 's have'} completed; a median ` +
            `lead time is taken over more. `) + `${reading.inflight} in flight, ${reading.queued} waiting.`,
    };
  }
  return {
    headline: 'Healthy',
    detail:
      `${reading.inflight} in flight, ${reading.queued} waiting.` +
      (reading.runwayMinutes === null ? '' : ` About ${humanMinutes(reading.runwayMinutes)} of work queued.`),
  };
}

function heldClause(reading: Omit<RunwayReading, 'headline' | 'detail'>): string | null {
  const held = reading.medianHeldMinutes ?? 0;
  const lead = reading.medianLeadMinutes ?? 0;
  if (held <= 0) return null;
  return (
    `That goal's median calendar span is ${humanMinutes(lead + held)} — the ${humanMinutes(held)} of it ` +
    `spent waiting on you is not the fleet's time and is not counted.`
  );
}

function latentClause(latent: LatentSupply): string | null {
  const parts: string[] = [];
  if (latent.plans > 0) parts.push(`${latent.plans} plan${latent.plans === 1 ? '' : 's'} awaiting approval`);
  if (latent.profiles > 0) parts.push(`${latent.profiles} profile gate${latent.profiles === 1 ? '' : 's'}`);
  if (latent.escalated > 0) parts.push(`${latent.escalated} escalated goal${latent.escalated === 1 ? '' : 's'}`);
  if (parts.length === 0) return null;
  const answers = latent.plans + latent.profiles + latent.escalated;
  const releases =
    latent.parts > 0
      ? ` — answering them puts ${latent.parts} part${latent.parts === 1 ? '' : 's'} back in the fleet`
      : ' — answering them is what releases the next work';
  return `${capitalise(list(parts))} ${answers === 1 ? 'is' : 'are'} standing${releases}.`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type RunwayStep =
  | { kind: 'file'; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string }
  | { kind: 'reopen'; taskId: string; detail: string };

export function runwayPass(input: {
  reading: RunwayReading;
  existing: readonly HumanTask[];
  enabled: boolean;
}): RunwayStep[] {
  const steps: RunwayStep[] = [];
  const wanted = FILES.has(input.reading.state) && input.enabled ? input.reading.headline : null;
  const open = input.existing.filter((t) => t.status === 'open');

  for (const row of open) {
    if (row.title === wanted) continue;
    steps.push({
      kind: 'settle',
      taskId: row.id,
      status: 'done',
      resolution:
        DESK_SETTLED +
        (wanted === null
          ? `the queue recovered — ${input.reading.detail}`
          : `superseded: ${input.reading.headline.toLowerCase()}`),
    });
  }
  if (wanted === null) return steps;
  const settled = input.existing.filter((t) => t.status !== 'open' && t.title === wanted);
  if (settled.some((t) => !deskSettled(t))) return steps;
  const mine = settled[0];
  if (mine) steps.push({ kind: 'reopen', taskId: mine.id, detail: input.reading.detail });
  else steps.push({ kind: 'file', title: wanted, detail: input.reading.detail });
  return steps;
}

const FILES = new Set<SupplyState>(['thin', 'dry', 'starved']);
