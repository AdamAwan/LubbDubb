import type { Agent, AppState, OpenPullRequest, PullRequest, TaskSummary } from '../types.js';
import type { NeedKind, NeedRow } from './needsYou.js';
import { closedPrs, goalOfPr, standsFor } from './goalPage.js';

/**
 * What is in the way of a Feature's stories, who clears it, and who is on them.
 *
 * **A lens, on the goal page's terms.** Every hold here is a verdict some other
 * module already reached — the needs-you rail's row, the pull request's
 * `attention`, the issue's `pickup`, the reach row's `gateHold`, the fleet's
 * `parkedOnLimit` list — mapped onto three courts and drawn in its owner's own
 * words. Nothing is judged here: no "at risk", no age read as lateness, no
 * verdict the snapshot did not already carry. A hold the card would like to show
 * and cannot find in the state is a hold the module that owns it has to raise.
 *
 * | court   | source                                    | kind          | title                       |
 * |---------|-------------------------------------------|---------------|-----------------------------|
 * | `you`   | a rail row on one of the goals            | its `NeedKind`| the row's own sentence      |
 * | `you`   | PR `attention.status === 'you'`, no row   | `pr`          | `attention.reasons[0]`      |
 * | `fleet` | `pickup.status` ∈ {@link FLEET_PICKUP}    | `pickup`      | `pickup.reasons[0]`         |
 * | `fleet` | `parkedOnLimit` agent whose task is a goal's | `limit`    | the agent's `waitingReason` |
 * | `fleet` | PR `attention.status === 'harness'`       | `pr`          | `attention.reasons[0]`      |
 * | `world` | PR `attention.status` ∈ {elsewhere, stalled} | `pr`       | `attention.reasons[0]`      |
 * | `world` | reach row with a non-null `gateHold`      | `gate`        | the `gateHold` string       |
 *
 * `settled`, `done` and `unwatched` pull requests draw nothing, and so does an
 * `unwatched` pickup: the card's own attention line already says an unseen item
 * is neither queued nor held, and a hold for it would say the opposite.
 *
 * Fleet-wide rail rows ({@link FLEET_WIDE}) are not a goal's and are left out —
 * except a `limit` park, which comes back in through `parkedOnLimit` as a fleet
 * hold on the goal its task was dispatched for, carrying the rail row's id so the
 * card can open the same resume control.
 *
 * Within a bucket, rail rows come first in the rail's own order — the rail has
 * already sorted them by what they hold — then everything else newest first by
 * `since`, stable, with the undated last.
 */

type HoldCourt = 'you' | 'fleet' | 'world';

export interface FeatureHold {
  court: HoldCourt;
  /** What kind of thing it is: a NeedKind for a rail row, or 'pr' | 'pickup' | 'gate' | 'limit'. */
  kind: string;
  /** One line, in its owner's words. */
  title: string;
  /** A second, quieter line — a reason clause or an age — or null. */
  detail: string | null;
  /** `issue:<n>` or `pr:<n>` — where the answer is. Null only when nothing names one. */
  ref: string | null;
  /** The child goal this hold belongs to, or null for a PR with no goal. */
  goal: number | null;
  /** The rail row's id when this hold IS a rail row (so the card can open the same ask panel). */
  needId: string | null;
  /** The agent parked or working on it, when there is one. */
  agentId: string | null;
  /** A stamp to draw as an age, or null. Never judged. */
  since: string | null;
  /**
   * The rail's own tone for a rail row. Always null here: `KIND_TONE` lives in
   * `web/src/console/QueueRail.tsx`, which a view module must not import, and
   * re-declaring it would be a second table to drift. The component looks the
   * tone up by `kind`, which for a rail row is the `NeedKind` the table is keyed on.
   */
  tone: 'red' | 'amber' | 'blue' | 'green' | null;
}

export interface FeaturePresence {
  agentId: string;
  /** `working` = status running/starting; `holding` = status waiting (parked on a question or the usage limit). */
  state: 'working' | 'holding';
  /** The agent's own note, or its task title. */
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

/** The pickup verdicts that say the harness itself is holding the goal. */
const FLEET_PICKUP = new Set<string>(['cooldown', 'blocked', 'planning', 'appraisal', 'obstacle']);

/** Rail kinds about the harness as a whole, which no goal owns. */
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

/** The goal number a `pr:<n>` or `pr:<n>:…` ref names, read through {@link goalOfPr}. */
function prNumberOf(ref: string | null): number | null {
  const m = ref === null ? null : /^pr:(\d+)(?::|$)/.exec(ref);
  return m ? Number(m[1]) : null;
}

/**
 * The goal a dispatch origin belongs to, as a number — `issue:<n>` and every ref
 * built on it, or a pull request ref read through the goal that owns the PR.
 * Looser than `goalOfOrigin` on the PR arm on purpose: a CI dispatch is at
 * `pr:412:ci`, and an agent on it is an agent on the goal.
 */
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

/** Newest first by `since`, undated last, stable. */
function bySinceDesc(a: FeatureHold, b: FeatureHold): number {
  if (a.since === b.since) return 0;
  if (a.since === null) return 1;
  if (b.since === null) return -1;
  return b.since.localeCompare(a.since);
}

/** The live agent dispatched at this pull request, when there is one. */
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

/** Holds and presence for the goals given (a Feature's children, or one promoted goal). */
export function featureHolds(state: AppState, needs: readonly NeedRow[], goals: readonly number[]): FeatureHolds {
  const wanted = new Set(goals);
  const you: FeatureHold[] = [];
  const fleet: FeatureHold[] = [];
  const world: FeatureHold[] = [];

  // The rail's rows on these goals, in the rail's order. A row is a goal's by its
  // `goalRef`, or by the goal owning the pull request it was raised on — the
  // same two ways the rail itself routes a row to a goal page.
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
      // A merge proposal's row and the PR's own verdict are one hold; the row wins
      // because it carries the control that answers it.
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

/** `pr:<n>` when the origin names a pull request, the goal's own ref otherwise. */
function refOf(state: AppState, originRef: string | null, goal: number): string {
  const pr = prNumberOf(standsFor(state, originRef));
  return pr === null ? `issue:${goal}` : `pr:${pr}`;
}

/**
 * Every live agent on one of the goals. `waiting` is holding whatever it is
 * parked on — a question or the usage limit — and the two other live statuses are
 * working. Ended agents are history, and the card draws none of it.
 */
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
  /** 1-based rung position and stack size from state.stacks, or null when not in a stack. */
  position: number | null;
  stackSize: number | null;
}

/**
 * The pull requests that are this goal's, bottom rung first within a stack, then
 * the rest newest first — open ones before closed.
 *
 * Ownership is {@link goalOfPr} run over the world: a part's row, the tracker's
 * own link, or the branch convention — the same three ways the goal page keeps a
 * pull request. "Newest" is the higher number for an open pull request, which
 * carries no stamp of its own, and the later `closedAt` for a closed one.
 */
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
