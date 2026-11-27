import type { CockpitView } from './viewModel.js';
import type { Agent, Issue, ListenItem, OpenPullRequest, PlanPart } from '../types.js';
import type { NeedRow } from './needsYou.js';
import { buildGoalPage, type GoalPageView } from './goalPage.js';
import { closeStage, validationStage, watchStage, type GoalStage } from './goalStages.js';
import { goalIssue, goalNumber, goalOfOrigin, goalOfPr, standsFor } from './goalRefs.js';
import { sameItem } from './needsYouPage.js';

// → docs/spec/17-cockpit.md#the-work-tab

/** The row that collects what belongs to no goal: ticketless pull requests, and asks raised on none. */
export const NO_GOAL = 'none';

const IN_FLIGHT = new Set(['active', 'has_pr', 'planning', 'investigation', 'parked', 'escalated']);

export interface GoalWork {
  ref: string;
  issue: Issue | undefined;
  page: GoalPageView | null;
  asks: NeedRow[];
  prs: OpenPullRequest[];
  agents: Agent[];
}

export interface FeatureGroup {
  /** The Feature's issue number, or null for the goals that hang off none. */
  number: number | null;
  title: string | null;
  goals: GoalWork[];
}

export interface Hold {
  text: string;
  tone: 'ask' | 'hold';
  /** A blocked part — said on the parts line too, so an open row leaves it out of Held. */
  part: boolean;
}

export type Tone = 'ask' | 'hold' | 'done' | 'quiet';

export interface PrReading {
  text: string;
  tone: Tone;
}

export interface WorkPart {
  part: PlanPart;
  pr: OpenPullRequest | undefined;
  mark: '✓' | '⏸' | '▶' | '';
  tone: Tone;
}

export interface LaterStage {
  name: 'Validate' | 'Close' | 'Watch';
  stage: GoalStage;
}

/** One entry per goal with anything to say: in flight, or holding an ask, a pull request or an agent. */
export function goalsOfWork(view: CockpitView): GoalWork[] {
  const { state } = view;
  const byRef = new Map<string, GoalWork>();
  const at = (ref: string | null): GoalWork => {
    const key = ref ?? NO_GOAL;
    let work = byRef.get(key);
    if (work === undefined) {
      work = {
        ref: key,
        issue: ref === null ? undefined : goalIssue(state, ref),
        page: ref === null ? null : buildGoalPage(state, ref, view.needsYou, null),
        asks: [],
        prs: [],
        agents: [],
      };
      byRef.set(key, work);
    }
    return work;
  };
  for (const issue of state.world.issues) if (IN_FLIGHT.has(issue.pickup.status)) at(`issue:${issue.number}`);
  for (const row of view.needsYou) if (row.goalRef !== null) at(row.goalRef).asks.push(row);
  for (const pr of state.world.pullRequests) at(goalOfPr(state, pr.number)).prs.push(pr);
  for (const agent of view.live) {
    const goal = goalOfOrigin(state, standsFor(state, view.taskFor(agent)?.originRef ?? null));
    if (goal !== null) at(goal).agents.push(agent);
  }
  return [...byRef.values()].sort(byUrgency);
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
  return work.issue !== undefined && IN_FLIGHT.has(work.issue.pickup.status);
}

/** The goals under the Feature each hangs off, in first-seen order, with the ones under none last. */
export function byFeature(goals: readonly GoalWork[]): FeatureGroup[] {
  const groups = new Map<number | null, FeatureGroup>();
  for (const work of goals) {
    const parent = work.issue?.parent ?? null;
    const key = parent?.number ?? null;
    let group = groups.get(key);
    if (group === undefined) {
      group = { number: key, title: parent?.title ?? null, goals: [] };
      groups.set(key, group);
    }
    group.goals.push(work);
  }
  return [...groups.values()].sort((a, b) => Number(a.number === null) - Number(b.number === null));
}

/**
 * Everything standing between the goal and its next step, from every place that knows one: the asks
 * on the operator, a stack that cannot land, a blocked part, and the queue's own reason for holding
 * its work. Each is quoted, never reworded; a reading said twice is said once.
 */
export function holdsOf(work: GoalWork, view: CockpitView): Hold[] {
  const { state } = view;
  const holds: Hold[] = work.asks.map((a) => ({ text: a.summary ?? a.title, tone: 'ask', part: false }));
  const prNumbers = new Set(work.prs.map((pr) => pr.number));
  for (const stack of state.stacks) {
    if (!stack.rungs.some((r) => prNumbers.has(r.prNumber))) continue;
    const blocked = state.stackLandings.find((l) => l.ref === stack.ref)?.blockedBy;
    if (blocked != null) holds.push({ text: `stack can’t land: ${blocked}`, tone: 'hold', part: false });
  }
  for (const { part } of work.page?.parts ?? []) {
    if (part.status === 'blocked')
      holds.push({ text: `part “${part.slug}”: ${part.blockedReason ?? 'blocked'}`, tone: 'hold', part: true });
  }
  if (work.ref !== NO_GOAL) {
    for (const item of view.upNext) {
      if (item.status === 'dispatching') continue;
      if (goalOfOrigin(state, standsFor(state, item.origin)) !== work.ref) continue;
      holds.push({ text: item.reason, tone: 'hold', part: false });
    }
  }
  const seen = new Set<string>();
  return holds.filter((h) => {
    if (seen.has(h.text)) return false;
    seen.add(h.text);
    return true;
  });
}

/** A pull request in one reading: the operator's court first, then a red build, then its own first reason. */
export function prReading(pr: OpenPullRequest): PrReading {
  if (pr.attention.status === 'you') return { text: 'your call', tone: 'ask' };
  if (pr.ciStatus === 'failing') return { text: 'CI failing', tone: 'hold' };
  return { text: pr.attention.reasons[0] ?? pr.attention.status, tone: 'quiet' };
}

const PART_MARK: Partial<Record<PlanPart['status'], WorkPart['mark']>> = {
  merged: '✓',
  concluded: '✓',
  blocked: '⏸',
  dispatched: '▶',
  in_review: '▶',
};

/** The plan's live parts in plan order, each with its open pull request and how it reads. */
export function workParts(page: GoalPageView, prs: readonly OpenPullRequest[]): WorkPart[] {
  return page.parts
    .map((p) => p.part)
    .filter((p) => p.status !== 'retired')
    .sort((a, b) => a.seq - b.seq)
    .map((part) => {
      const pr = part.prNumber === null ? undefined : prs.find((p) => p.number === part.prNumber);
      const mark = PART_MARK[part.status] ?? (pr === undefined ? '' : '▶');
      const tone: Tone =
        part.status === 'blocked' ? 'hold' : pr !== undefined ? prReading(pr).tone : mark === '✓' ? 'done' : 'quiet';
      return { part, pr, mark, tone };
    });
}

/** The goal's open pull requests no part of its plan names. */
export function strayPrs(page: GoalPageView, prs: readonly OpenPullRequest[]): OpenPullRequest[] {
  const inPlan = new Set(page.parts.flatMap((p) => (p.part.prNumber === null ? [] : [p.part.prNumber])));
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

/** Whether the listening chat holds this item: working it, or handed it and not yet done. */
export function inChat(view: CockpitView, item: ListenItem): boolean {
  const { listener } = view.state;
  if (listener.on !== null && sameItem(listener.on, item)) return true;
  return listener.sent.some((entry) => sameItem(entry.item, item));
}

/** Whether anything of this goal's — an ask or a pull request — is in the listening chat. */
export function goalInChat(view: CockpitView, work: GoalWork): boolean {
  return [
    ...work.asks.map((a): ListenItem => ({ kind: 'ask', id: a.id })),
    ...work.prs.map((pr): ListenItem => ({ kind: 'pr', number: pr.number })),
  ].some((item) => inChat(view, item));
}
