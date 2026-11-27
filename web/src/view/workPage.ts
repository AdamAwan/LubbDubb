import type { CockpitView } from './viewModel.js';
import type { Agent, Issue, OpenPullRequest, Plan, PlanPart } from '../types.js';
import type { NeedRow } from './needsYou.js';
import { goalObligations, reachFields, type GoalPageView } from './goalPage.js';
import {
  buildGoalTrack,
  closeStage,
  courtStage,
  partsStage,
  planRecordStage,
  validationStage,
  watchStage,
  type CloseInputs,
  type GoalStage,
  type WatchInputs,
} from './goalStages.js';
import type { GoalTrack } from './goalPage.js';
import { goalIssue, goalNumber, goalOfOrigin, goalOfPr } from './goalRefs.js';
import { liveParts, PART_GROUP } from './partGroups.js';
import type { PartGroup } from '../types.js';
import { prOnYouReasons } from './needsYouPage.js';
import { PR_REASON_LABEL } from './prsOnYou.js';
import { WORK_IN_FLIGHT } from './pickup.js';

// → docs/spec/17-cockpit.md#the-work-tab

/** The row that collects what belongs to no goal: ticketless pull requests, and asks raised on none. */
export const NO_GOAL = 'none';

export interface GoalWork {
  ref: string;
  issue: Issue | undefined;
  /** The plan's live parts in plan order; empty with no plan. */
  parts: PlanPart[];
  asks: NeedRow[];
  prs: OpenPullRequest[];
  agents: Agent[];
  holds: Hold[];
  /** Plan → Build → Validate → Close → Watch; empty on the No goal row. */
  stages: WorkStage[];
}

export interface WorkStage {
  name: 'Plan' | 'Build' | 'Validate' | 'Close' | 'Watch';
  stage: GoalStage;
  /** `merged/total` on Build where the plan has parts, whatever the reading leads with. */
  count: string | null;
}

interface FeatureGroup {
  number: number;
  title: string;
  goals: GoalWork[];
}

/** The Work tab's top level: the Features, each with its goals, then each goal under none on its own. */
interface TopLevel {
  features: FeatureGroup[];
  loose: GoalWork[];
}

export interface Hold {
  text: string;
  tone: 'ask' | 'hold';
  /** A blocked part — said on the parts line too, so an open row leaves it out of Held. */
  part: boolean;
}

type Tone = 'ask' | 'hold' | 'done' | 'quiet';

export interface PrReading {
  text: string;
  tone: Tone;
}

export interface WorkPart {
  part: PlanPart;
  pr: OpenPullRequest | undefined;
  reading: PrReading | undefined;
  mark: '✓' | '⏸' | '▶' | '';
  tone: Tone;
}

export interface LaterStage {
  name: 'Validate' | 'Close' | 'Watch';
  stage: GoalStage;
}

/** What the snapshot says once, read by every goal: each plan's live parts, stack holds by PR, queue holds by goal. */
interface WorkIndex {
  partsOf: (ref: string) => PlanPart[];
  planOf: Map<string, Plan>;
  stackHolds: Map<number, string>;
  queueHolds: Map<string, string[]>;
  closeOf: (issue: Issue, ref: string) => CloseInputs;
  watchOf: (ref: string) => WatchInputs;
}

function groupBy<T>(items: readonly T[] | undefined, key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items ?? []) {
    const list = out.get(key(item)) ?? [];
    list.push(item);
    out.set(key(item), list);
  }
  return out;
}

/** Each goal's live plan parts in plan order — the first plan on a goal, as the goal page reads it. */
function partsByGoal(state: CockpitView['state'], plans: ReadonlyMap<string, Plan>): (ref: string) => PlanPart[] {
  const byPlan = groupBy(liveParts(state.planParts ?? []), (part) => part.planId);
  for (const list of byPlan.values()) list.sort((a, b) => a.seq - b.seq);
  return (ref) => byPlan.get(plans.get(ref)?.id ?? '') ?? [];
}

function indexWork(view: CockpitView): WorkIndex {
  const { state } = view;
  const planOf = new Map<string, Plan>();
  for (const plan of state.plans ?? []) if (!planOf.has(plan.originRef)) planOf.set(plan.originRef, plan);
  const partsOf = partsByGoal(state, planOf);

  const stackHolds = new Map<number, string>();
  for (const stack of state.stacks) {
    const blocked = state.stackLandings.find((l) => l.ref === stack.ref)?.blockedBy;
    if (blocked == null) continue;
    for (const rung of stack.rungs) stackHolds.set(rung.prNumber, `stack can’t land: ${blocked}`);
  }

  const held = view.upNext.flatMap((item) => {
    const goal = item.status === 'dispatching' ? null : goalOfOrigin(state, item.origin);
    return goal === null ? [] : [{ goal, reason: item.reason }];
  });
  const queueHolds = new Map([...groupBy(held, (h) => h.goal)].map(([goal, hs]) => [goal, hs.map((h) => h.reason)]));

  const reach = new Map((state.environmentReach ?? []).map((r) => [r.goalRef, r]));
  const closeOf = (issue: Issue, ref: string): CloseInputs => ({ issue, ...reachFields(reach.get(ref)) });
  const obligations = goalObligations(state.config.environments);
  const windows = groupBy(state.goalWatchWindows, (w) => w.goalRef);
  const signals = groupBy(state.goalWatches, (w) => w.originRef);
  const watchPlans = new Map((state.watchPlans ?? []).map((r) => [r.goalRef, r]));
  const watchOf = (ref: string): WatchInputs => ({
    obligations,
    watches: windows.get(ref) ?? [],
    signals: signals.get(ref) ?? [],
    watchPlan: watchPlans.get(ref) ?? null,
  });
  return { partsOf, planOf, stackHolds, queueHolds, closeOf, watchOf };
}

/** One entry per goal with anything to say: in flight, or holding an ask, a pull request or an agent. */
export function goalsOfWork(view: CockpitView): GoalWork[] {
  const { state } = view;
  const index = indexWork(view);
  const byRef = new Map<string, GoalWork>();
  const at = (ref: string | null): GoalWork => {
    const key = ref ?? NO_GOAL;
    let work = byRef.get(key);
    if (work === undefined) {
      work = {
        ref: key,
        issue: ref === null ? undefined : goalIssue(state, ref),
        parts: ref === null ? [] : index.partsOf(ref),
        asks: [],
        prs: [],
        agents: [],
        holds: [],
        stages: [],
      };
      byRef.set(key, work);
    }
    return work;
  };
  for (const issue of state.world.issues) if (WORK_IN_FLIGHT.has(issue.pickup.status)) at(`issue:${issue.number}`);
  for (const row of view.needsYou) at(row.goalRef).asks.push(row);
  for (const pr of state.world.pullRequests) at(goalOfPr(state, pr.number)).prs.push(pr);
  for (const agent of view.live) {
    const goal = goalOfOrigin(state, view.taskFor(agent)?.originRef ?? null);
    if (goal !== null) at(goal).agents.push(agent);
  }
  const goals = [...byRef.values()];
  for (const work of goals) {
    work.holds = holdsOf(work, index);
    work.stages = stagesOf(work, index);
  }
  return goals.sort(byUrgency);
}

/**
 * The goal's five stages, read off the snapshot without building the goal page: Plan and Build
 * split what the goal page's one Plan stage says, and the last three are the goal page's own.
 */
function stagesOf(work: GoalWork, index: WorkIndex): WorkStage[] {
  const { issue } = work;
  if (issue === undefined) return [];
  const track = workTrack(work.parts);
  const count = track.total > 0 ? `${track.merged}/${track.total}` : null;
  return [
    { name: 'Plan', stage: planOnly(work, issue, index.planOf.get(work.ref)), count: null },
    { name: 'Build', stage: buildStage(work, issue, track), count },
    { name: 'Validate', stage: validationStage({ issue }), count: null },
    { name: 'Close', stage: closeStage(index.closeOf(issue, work.ref)), count: null },
    { name: 'Watch', stage: watchStage(index.watchOf(work.ref)), count: null },
  ];
}

/** The plan record alone; a goal worked without one reads as needing none once it has a pull request. */
function planOnly(work: GoalWork, issue: Issue, plan: Plan | undefined): GoalStage {
  if (plan === undefined) {
    if (work.prs.length > 0 || issue.delivery != null) return { reading: 'no plan needed', tone: 'green', done: null };
    if (issue.pickup.status === 'planning') return { reading: 'being drawn', tone: 'blue', done: null };
  }
  return planRecordStage(plan ?? null) ?? { reading: 'approved', tone: 'green', done: null };
}

/** The plan's parts merged, or the goal's pull requests where it has no parts; a PR on the operator reads amber. */
function buildStage(work: GoalWork, issue: Issue, track: GoalTrack): GoalStage {
  const parts = partsStage(track);
  const court = courtStage(work.prs, parts?.done ?? null);
  if (court !== null) return court;
  if (parts !== null) return parts;
  if (issue.delivery != null || issue.state !== 'open') return { reading: 'delivered', tone: 'green', done: null };
  if (work.prs.length > 0) return { reading: `${work.prs.length} open`, tone: 'blue', done: null };
  if (work.agents.length > 0) return { reading: 'being worked', tone: 'blue', done: null };
  return { reading: 'not started', tone: 'grey', done: null };
}

function rank(work: GoalWork): number {
  if (work.ref === NO_GOAL) return 4;
  if (work.issue?.priority != null) return 0;
  if (work.asks.some((a) => a.urgency === 'now')) return 1;
  return work.asks.length > 0 ? 2 : 3;
}

function byUrgency(a: GoalWork, b: GoalWork): number {
  return rank(a) - rank(b) || (goalNumber(a.ref) ?? 0) - (goalNumber(b.ref) ?? 0);
}

/** In flight by its pickup status, or with a pull request open or an agent on it whatever the status says. */
export function inFlight(work: GoalWork): boolean {
  if (work.ref === NO_GOAL || work.prs.length > 0 || work.agents.length > 0) return true;
  return work.issue !== undefined && WORK_IN_FLIGHT.has(work.issue.pickup.status);
}

/** The goals under the Feature each hangs off, in first-seen order; a goal under none stands alone. */
export function byFeature(goals: readonly GoalWork[]): TopLevel {
  const groups = new Map<number, FeatureGroup>();
  const loose: GoalWork[] = [];
  for (const work of goals) {
    const parent = work.issue?.parent ?? null;
    if (parent === null) {
      loose.push(work);
      continue;
    }
    let group = groups.get(parent.number);
    if (group === undefined) {
      group = { number: parent.number, title: parent.title, goals: [] };
      groups.set(parent.number, group);
    }
    group.goals.push(work);
  }
  return { features: [...groups.values()], loose };
}

/**
 * Everything standing between the goal and its next step, from every place that knows one: the asks
 * on the operator, a stack that cannot land, a blocked part, and the queue's own reason for holding
 * its work. Each is quoted, never reworded; a reading said twice is said once.
 */
function holdsOf(work: GoalWork, index: WorkIndex): Hold[] {
  const holds: Hold[] = work.asks.map((a) => ({ text: a.summary ?? a.title, tone: 'ask', part: false }));
  for (const pr of work.prs) {
    const stack = index.stackHolds.get(pr.number);
    if (stack !== undefined) holds.push({ text: stack, tone: 'hold', part: false });
  }
  for (const part of work.parts) {
    if (part.status === 'blocked')
      holds.push({ text: `part “${part.slug}”: ${part.blockedReason ?? 'blocked'}`, tone: 'hold', part: true });
  }
  if (work.ref !== NO_GOAL) {
    for (const reason of index.queueHolds.get(work.ref) ?? []) holds.push({ text: reason, tone: 'hold', part: false });
  }
  const seen = new Set<string>();
  return holds.filter((h) => {
    if (seen.has(h.text)) return false;
    seen.add(h.text);
    return true;
  });
}

/** A pull request in one reading: why it is on the operator, as Needs you says it, then a red build, then its own first reason. */
export function prReading(pr: OpenPullRequest): PrReading {
  const onYou = prOnYouReasons(pr)[0];
  if (onYou !== undefined) return { text: PR_REASON_LABEL[onYou], tone: 'ask' };
  if (pr.ciStatus === 'failing') return { text: 'CI failing', tone: 'hold' };
  return { text: pr.attention.reasons[0] ?? pr.attention.status, tone: 'quiet' };
}

const GROUP_MARK: Record<PartGroup, WorkPart['mark']> = { merged: '✓', held: '⏸', now: '▶', waiting: '' };

/** The plan's live parts in plan order, each with its open pull request and how it reads. */
export function workParts(parts: readonly PlanPart[], prs: readonly OpenPullRequest[]): WorkPart[] {
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  return parts.map((part) => {
    const pr = part.prNumber === null ? undefined : byNumber.get(part.prNumber);
    const reading = pr === undefined ? undefined : prReading(pr);
    const group = PART_GROUP[part.status];
    const mark = group === null || group === 'waiting' ? (pr === undefined ? '' : '▶') : GROUP_MARK[group];
    const tone: Tone =
      part.status === 'blocked' ? 'hold' : reading !== undefined ? reading.tone : mark === '✓' ? 'done' : 'quiet';
    return { part, pr, reading, mark, tone };
  });
}

/** The plan's progress track, read off its live parts without building the goal page. */
function workTrack(parts: readonly PlanPart[]): GoalTrack {
  return buildGoalTrack(
    parts.flatMap((part) => {
      const group = PART_GROUP[part.status];
      return group === null ? [] : [{ group }];
    }),
  );
}

/** The goal's open pull requests no part of its plan names. */
export function strayPrs(parts: readonly PlanPart[], prs: readonly OpenPullRequest[]): OpenPullRequest[] {
  const inPlan = new Set(parts.flatMap((p) => (p.prNumber === null ? [] : [p.prNumber])));
  return prs.filter((pr) => !inPlan.has(pr.number));
}

/** The stages past the plan that have something to say; a grey stage is one with nothing yet. */
export function laterStages(page: GoalPageView): LaterStage[] {
  const stages: LaterStage[] = [
    { name: 'Validate', stage: validationStage(page) },
    { name: 'Close', stage: closeStage(page) },
    { name: 'Watch', stage: watchStage(page) },
  ];
  return stages.filter((s) => s.stage.tone !== 'grey');
}
