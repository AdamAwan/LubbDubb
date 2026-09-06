import type { Agent, AppState, OpenPullRequest, PullRequest, TaskSummary } from '../types.js';
import type { NeedKind, NeedRow } from './needsYou.js';
import { closedPrs, goalOfPr, standsFor } from './goalPage.js';

// → docs/spec/17-cockpit.md

type HoldCourt = 'you' | 'fleet' | 'world';

export interface FeatureHold {
  court: HoldCourt;
  kind: string;
  title: string;
  detail: string | null;
  ref: string | null;
  goal: number | null;
  needId: string | null;
  agentId: string | null;
  since: string | null;
  tone: 'red' | 'amber' | 'blue' | 'green' | null;
}

export interface FeaturePresence {
  agentId: string;
  state: 'working' | 'holding';
  note: string | null;
  goal: number | null;
  prNumber: number | null;
}

export interface FeatureHolds {
  you: FeatureHold[];
  fleet: FeatureHold[];
  world: FeatureHold[];
  agents: FeaturePresence[];
}

const FLEET_PICKUP = new Set<string>(['cooldown', 'blocked', 'planning', 'appraisal', 'obstacle']);

const FLEET_WIDE = new Set<NeedKind>([
  'config',
  'config_gap',
  'recovery',
  'burn',
  'limit',
  'supply',
  'dispatch',
  'upgrade',
  'project_pull',
]);

const WORLD_PR = new Set<string>(['elsewhere', 'stalled']);

function prNumberOf(ref: string | null): number | null {
  const m = ref === null ? null : /^pr:(\d+)(?::|$)/.exec(ref);
  return m ? Number(m[1]) : null;
}

function goalNumberOf(state: AppState, originRef: string | null): number | null {
  const ref = standsFor(state, originRef);
  if (ref === null) return null;
  const issue = /^issue:(\d+)(?::|$)/.exec(ref);
  if (issue) return Number(issue[1]);
  const pr = prNumberOf(ref);
  return pr === null ? null : goalNumber(goalOfPr(state, pr));
}

function goalNumber(goalRef: string | null): number | null {
  const m = goalRef === null ? null : /^issue:(\d+)$/.exec(goalRef);
  return m ? Number(m[1]) : null;
}

function bySinceDesc(a: FeatureHold, b: FeatureHold): number {
  if (a.since === b.since) return 0;
  if (a.since === null) return 1;
  if (b.since === null) return -1;
  return b.since.localeCompare(a.since);
}

function agentOnPr(state: AppState, prNumber: number): Agent | undefined {
  return state.agents.find((a) => {
    if (a.endedAt !== null) return false;
    const task = state.tasks.find((t) => t.id === a.taskId);
    return prNumberOf(standsFor(state, task?.originRef ?? null)) === prNumber;
  });
}

function prHold(state: AppState, pr: OpenPullRequest, court: HoldCourt, goal: number | null): FeatureHold {
  return {
    court,
    kind: 'pr',
    title: pr.attention.reasons[0] ?? '',
    detail: pr.attention.reasons[1] ?? null,
    ref: `pr:${pr.number}`,
    goal,
    needId: null,
    agentId: agentOnPr(state, pr.number)?.id ?? null,
    since: pr.attention.reviewWaitingSince ?? null,
    tone: null,
  };
}

export function featureHolds(state: AppState, needs: readonly NeedRow[], goals: readonly number[]): FeatureHolds {
  const wanted = new Set(goals);
  const you: FeatureHold[] = [];
  const fleet: FeatureHold[] = [];
  const world: FeatureHold[] = [];

  const covered = new Set<number>();
  for (const row of needs) {
    if (FLEET_WIDE.has(row.kind)) continue;
    const goal = goalNumber(row.goalRef) ?? goalNumberOf(state, row.originRef);
    if (goal === null || !wanted.has(goal)) continue;
    const pr = prNumberOf(row.originRef);
    if (pr !== null) covered.add(pr);
    you.push({
      court: 'you',
      kind: row.kind,
      title: row.title,
      detail: row.note ?? row.agentLabel ?? null,
      ref: pr === null ? row.goalRef : `pr:${pr}`,
      goal,
      needId: row.id,
      agentId: row.agentId,
      since: row.raisedAt === '' ? null : row.raisedAt,
      tone: null,
    });
  }

  const rest: Record<HoldCourt, FeatureHold[]> = { you: [], fleet: [], world: [] };

  for (const pr of state.world.pullRequests) {
    const goal = goalNumber(goalOfPr(state, pr.number));
    if (goal === null || !wanted.has(goal)) continue;
    const status = pr.attention.status;
    if (status === 'you') {
      if (!covered.has(pr.number)) rest.you.push(prHold(state, pr, 'you', goal));
    } else if (status === 'harness') {
      rest.fleet.push(prHold(state, pr, 'fleet', goal));
    } else if (WORLD_PR.has(status)) {
      rest.world.push(prHold(state, pr, 'world', goal));
    }
  }

  for (const goal of goals) {
    const ref = `issue:${goal}`;
    const issue = state.world.issues.find((i) => i.number === goal);
    if (issue && FLEET_PICKUP.has(issue.pickup.status)) {
      rest.fleet.push({
        court: 'fleet',
        kind: 'pickup',
        title: issue.pickup.reasons[0] ?? '',
        detail: issue.pickup.reasons[1] ?? null,
        ref,
        goal,
        needId: null,
        agentId: null,
        since: null,
        tone: null,
      });
    }
    const gateHold = (state.environmentReach ?? []).find((r) => r.goalRef === ref)?.gateHold ?? null;
    if (gateHold !== null) {
      rest.world.push({
        court: 'world',
        kind: 'gate',
        title: gateHold,
        detail: null,
        ref,
        goal,
        needId: null,
        agentId: null,
        since: null,
        tone: null,
      });
    }
  }

  for (const agentId of state.parkedOnLimit ?? []) {
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) continue;
    const task = state.tasks.find((t) => t.id === agent.taskId);
    const goal = goalNumberOf(state, task?.originRef ?? null);
    if (goal === null || !wanted.has(goal)) continue;
    const row = needs.find((n) => n.kind === 'limit' && n.id === agentId);
    rest.fleet.push({
      court: 'fleet',
      kind: 'limit',
      title: row?.title ?? agent.waitingReason ?? 'Parked: no usage allowance left right now.',
      detail: task?.title ?? null,
      ref: task?.originRef === undefined ? null : refOf(state, task.originRef, goal),
      goal,
      needId: row?.id ?? null,
      agentId,
      since: agent.startedAt,
      tone: null,
    });
  }

  you.push(...rest.you.sort(bySinceDesc));
  fleet.push(...rest.fleet.sort(bySinceDesc));
  world.push(...rest.world.sort(bySinceDesc));

  return { you, fleet, world, agents: presence(state, wanted) };
}

function refOf(state: AppState, originRef: string | null, goal: number): string {
  const pr = prNumberOf(standsFor(state, originRef));
  return pr === null ? `issue:${goal}` : `pr:${pr}`;
}

function presence(state: AppState, wanted: ReadonlySet<number>): FeaturePresence[] {
  const byId = new Map<string, FeaturePresence>();
  const tasks = new Map<string, TaskSummary>(state.tasks.map((t) => [t.id, t]));
  for (const agent of state.agents) {
    if (byId.has(agent.id)) continue;
    const live = agent.status === 'starting' || agent.status === 'running' || agent.status === 'waiting';
    if (!live) continue;
    const task = tasks.get(agent.taskId);
    const origin = standsFor(state, task?.originRef ?? null);
    const goal = goalNumberOf(state, origin);
    if (goal === null || !wanted.has(goal)) continue;
    byId.set(agent.id, {
      agentId: agent.id,
      state: agent.status === 'waiting' ? 'holding' : 'working',
      note: agent.note ?? task?.title ?? null,
      goal,
      prNumber: prNumberOf(origin),
    });
  }
  return [...byId.values()];
}

export interface GoalPullRequest {
  pr: OpenPullRequest | PullRequest;
  open: boolean;
  position: number | null;
  stackSize: number | null;
}

export function goalPullRequests(state: AppState, goal: number): GoalPullRequest[] {
  const ref = `issue:${goal}`;
  const owned = (pr: PullRequest) => goalOfPr(state, pr.number) === ref;

  const rung = (n: number): { position: number; size: number } | null => {
    for (const stack of state.stacks ?? []) {
      const r = stack.rungs.find((x) => x.prNumber === n);
      if (r) return { position: r.position, size: stack.rungs.length };
    }
    return null;
  };

  const open = state.world.pullRequests.filter(owned).map<GoalPullRequest>((pr) => {
    const r = rung(pr.number);
    return { pr, open: true, position: r?.position ?? null, stackSize: r?.size ?? null };
  });
  const stacked = open.filter((g) => g.position !== null).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const loose = open.filter((g) => g.position === null).sort((a, b) => b.pr.number - a.pr.number);

  const closed = closedPrs(state)
    .filter(owned)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || b.number - a.number)
    .map<GoalPullRequest>((pr) => ({ pr, open: false, position: null, stackSize: null }));

  return [...stacked, ...loose, ...closed];
}
