import type {
  Agent,
  AppState,
  GoalAgentsPayload,
  TaskSummary,
  CockpitDecision,
  Issue,
  OpenPullRequest,
  Plan,
  PlanPart,
  PullRequest,
  EnvironmentGateRelease,
  FeatureSequence,
  GoalEnvironmentReachView,
  GoalWatch,
  GoalWatchView,
  RemoteSheetView,
  ValidationCheckView,
  ValidationResourceView,
} from '../types.js';
import type { NeedRow } from './needsYou.js';

// → docs/spec/17-cockpit.md

export type PartGroup = 'merged' | 'now' | 'held' | 'waiting';

export interface GoalPartView {
  part: PlanPart;
  group: PartGroup;
  agentId: string | null;
  agentLive: boolean;
}

interface GoalAgentView {
  agent: Agent;
  onPr: number | null;
  title: string | null;
}

export interface GoalTrack {
  merged: number;
  now: number;
  held: number;
  waiting: number;
  total: number;
}

export interface GoalPageView {
  issue: Issue;
  needs: NeedRow[];
  plan: Plan | null;
  parts: GoalPartView[];
  retiredParts: PlanPart[];
  openPullRequests: OpenPullRequest[];
  closedPullRequests: PullRequest[];
  agents: GoalAgentView[];
  decisions: CockpitDecision[];
  checks: ValidationCheckView[];
  checkResources: ValidationResourceView[];
  environments: GoalEnvironmentReachView[];
  gateHold: string | null;
  gateRelease: EnvironmentGateRelease | null;
  remoteSheets: RemoteSheetView[];
  watches: GoalWatchView[];
  signals: GoalWatch[];
  sequence: FeatureSequence | null;
}

function belongsToGoal(candidate: string | null | undefined, ref: string): boolean {
  return candidate === ref || (candidate?.startsWith(`${ref}:`) ?? false);
}

function reachesGoal(state: AppState, origin: string | null, ref: string): boolean {
  if (belongsToGoal(origin, ref)) return true;
  const pr = origin === null ? null : /^pr:(\d+)$/.exec(origin);
  return pr !== null && goalOfPr(state, Number(pr[1])) === ref;
}

/**
 * Every pull request the cockpit knows to be closed: the world's `closedPrWindowMs` window plus
 * the archive, as one list. The window is written **second** so its row wins a collision (fresher).
 *
 * @public shared with prPage, which resolves a pull request through the same pair
 */
export function closedPrs(state: AppState): PullRequest[] {
  const byNumber = new Map<number, PullRequest>();
  for (const pr of state.archivedPullRequests ?? []) byNumber.set(pr.number, pr);
  for (const pr of state.world.closedPullRequests ?? []) byNumber.set(pr.number, pr);
  return [...byNumber.values()];
}

export function goalPrNumbers(state: AppState, ref: string): number[] {
  const plan = (state.plans ?? []).find((p) => p.originRef === ref) ?? null;
  const parts = plan === null ? [] : (state.planParts ?? []).filter((p) => p.planId === plan.id).map((p) => p.prNumber);
  const world = [...state.world.pullRequests, ...closedPrs(state)];
  return [
    ...new Set([
      ...parts.flatMap((n) => (n === null ? [] : [n])),
      ...world.filter((pr) => goalOfPr(state, pr.number) === ref).map((pr) => pr.number),
    ]),
  ];
}

function ownsPr(pr: PullRequest, issue: Issue, partPrs: ReadonlySet<number>): boolean {
  const ref = `issue:${issue.number}`;
  return partPrs.has(pr.number) || pr.number === issue.linkedPrNumber || branchGoal(pr.branch) === ref;
}

function branchGoal(branch: string): string | null {
  const m = /^issue\/(\d+)(?:\/|$)/.exec(branch);
  return m ? `issue:${m[1]}` : null;
}

/**
 * The goal a pull request belongs to, as `issue:<n>`, or null when no ticket owns it — the same
 * three ways {@link ownsPr} matches, read backwards. **Null is a real answer**: the harness works
 * ticketless pull requests as first-class subjects ([05](../../../docs/spec/05-dispatcher.md)).
 *
 * @public shared with buildNeedsYou, which routes a PR-origin ask by it
 */
export function goalOfPr(state: AppState, prNumber: number): string | null {
  const part = (state.planParts ?? []).find((p) => p.prNumber === prNumber);
  const plan = part ? (state.plans ?? []).find((pl) => pl.id === part.planId) : undefined;
  if (plan) return plan.originRef;

  const linked = state.world.issues.find((i) => i.linkedPrNumber === prNumber);
  if (linked) return `issue:${linked.number}`;

  const pr = [...state.world.pullRequests, ...closedPrs(state)].find((p) => p.number === prNumber);
  return pr ? branchGoal(pr.branch) : null;
}

/**
 * The goal a dispatch was raised against, as `issue:<n>` — the origin ref read through whichever
 * of its two shapes it wears (`issue:390`, or `pr:412`). Null for a ticketless pull request.
 *
 * @public shared with buildViewModel's agentOnGoal
 */
export function goalOfOrigin(state: AppState, originRef: string | null): string | null {
  const ref = standsFor(state, originRef);
  if (ref === null) return null;
  const issue = /^issue:(\d+)/.exec(ref);
  if (issue) return `issue:${issue[1]}`;
  const pr = /^pr:(\d+)$/.exec(ref);
  return pr ? goalOfPr(state, Number(pr[1])) : null;
}

const STANDS_FOR_DEPTH = 4;

/**
 * What a dispatch origin **stands in for** — a `job:<id>` origin read through to the work the job
 * is redoing (its `Job.originRef`), every other origin unchanged. Read literally, a crash recovery's
 * requeue would leave the goal whose work is out on the fleet reading as unstaffed. Null in, null
 * out; an origin whose job the snapshot no longer carries comes back **as itself**.
 *
 * @public shared with the console's fleet row, which draws both refs
 */
export function standsFor(state: AppState, originRef: string | null): string | null {
  let ref = originRef;
  for (let hop = 0; ref !== null && hop < STANDS_FOR_DEPTH; hop++) {
    const id = /^job:(.+)$/.exec(ref)?.[1];
    if (id === undefined) return ref;
    const job = state.jobs.find((j) => j.id === id);
    if (!job || job.originRef === null) return ref;
    ref = job.originRef;
  }
  return ref;
}

const GROUP_OF: Record<PlanPart['status'], PartGroup | null> = {
  merged: 'merged',
  concluded: 'merged',
  dispatched: 'now',
  in_review: 'now',
  blocked: 'held',
  ready: 'waiting',
  pending: 'waiting',
  retired: null,
};

/**
 * The issue a goal ref names — the world's copy, or a run retained after the ticket left the
 * world. Undefined for a ref with no goal behind it.
 *
 * @public shared with buildNeedsYou's destination rule
 */
export function goalIssue(state: AppState, ref: string): Issue | undefined {
  const number = Number(/^issue:(\d+)$/.exec(ref)?.[1]);
  if (!Number.isFinite(number)) return undefined;
  return (
    state.world.issues.find((i) => i.number === number) ?? (state.retainedRuns ?? []).find((i) => i.number === number)
  );
}

export function buildGoalPage(
  state: AppState,
  ref: string,
  needs: readonly NeedRow[],
  history: GoalAgentsPayload | null = null,
): GoalPageView | null {
  const issue = goalIssue(state, ref);
  if (!issue) return null;

  const tasksById = new Map<string, TaskSummary>(
    [...(history?.ref === ref ? history.tasks : []), ...state.tasks].map((t) => [t.id, t]),
  );
  const originOf = (agent: Agent): string | null => tasksById.get(agent.taskId)?.originRef ?? null;
  const onGoal = new Map<string, Agent>();
  for (const agent of [
    ...state.agents.filter((a) => reachesGoal(state, originOf(a), ref)),
    ...(history?.ref === ref ? history.agents : []),
  ]) {
    onGoal.set(agent.id, agent);
  }
  const goalAgents = [...onGoal.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const plan = (state.plans ?? []).find((p) => p.originRef === ref) ?? null;
  const parts = (state.planParts ?? [])
    .filter((p) => plan !== null && p.planId === plan.id)
    .flatMap<GoalPartView>((part) => {
      const group = GROUP_OF[part.status];
      if (!group) return [];
      const origins = new Set([`${ref}:part:${part.slug}`, ...(part.prNumber === null ? [] : [`pr:${part.prNumber}`])]);
      const on = goalAgents.filter((a) => origins.has(originOf(a) ?? ''));
      const agent = on.find((a) => a.endedAt === null) ?? on[0];
      return [{ part, group, agentId: agent?.id ?? null, agentLive: agent !== undefined && agent.endedAt === null }];
    })
    .sort((a, b) => a.part.seq - b.part.seq);

  const retiredParts = (state.planParts ?? [])
    .filter((p) => plan !== null && p.planId === plan.id && p.status === 'retired')
    .sort((a, b) => a.seq - b.seq);

  const partPrs = new Set(
    [...parts.map((p) => p.part), ...retiredParts].flatMap((p) => (p.prNumber === null ? [] : [p.prNumber])),
  );

  const reach = (state.environmentReach ?? []).find((e) => e.goalRef === ref);

  return {
    issue,
    needs: needs.filter((n) => n.goalRef === ref),
    plan,
    parts,
    retiredParts,
    openPullRequests: state.world.pullRequests.filter((pr) => ownsPr(pr, issue, partPrs)),
    closedPullRequests: closedPrs(state).filter((pr) => ownsPr(pr, issue, partPrs)),
    agents: goalAgents.map<GoalAgentView>((agent) => {
      const origin = originOf(agent);
      const pr = origin === null ? null : /^pr:(\d+)$/.exec(origin);
      return {
        agent,
        onPr: pr === null ? null : Number(pr[1]),
        title: tasksById.get(agent.taskId)?.title ?? null,
      };
    }),
    decisions: state.decisions.filter((d) => belongsToGoal(d.subjectRef, ref)),
    checks: (state.validationChecks ?? []).filter((c) => c.originRef === ref),
    checkResources: (state.validationResources ?? []).filter((r) => r.originRef === ref),
    environments: reach?.environments ?? [],
    gateHold: reach?.gateHold ?? null,
    gateRelease: reach?.released ?? null,
    remoteSheets: (state.remoteSheets ?? []).filter((s) => s.goalRef === ref),
    watches: (state.goalWatchWindows ?? []).filter((w) => w.goalRef === ref),
    signals: (state.goalWatches ?? []).filter((w) => w.originRef === ref),
    sequence: goalSequence(state, issue),
  };
}

function goalSequence(state: AppState, issue: Issue): FeatureSequence | null {
  const parent = issue.parent?.number;
  if (parent === undefined) return null;
  const row = (state.featureSequences ?? []).find((s) => s.originRef === `issue:${parent}`);
  return row?.status === 'accepted' ? row : null;
}

export function furthestEnvironment(state: AppState, goalRef: string): string | null {
  const reach = (state.environmentReach ?? []).find((e) => e.goalRef === goalRef);
  const reached = (reach?.environments ?? []).filter((e) => e.status === 'reached');
  return reached.length === 0 ? null : (reached[reached.length - 1]?.environment ?? null);
}

export function buildGoalTrack(parts: readonly GoalPartView[]): GoalTrack {
  const count = (g: PartGroup) => parts.filter((p) => p.group === g).length;
  return {
    merged: count('merged'),
    now: count('now'),
    held: count('held'),
    waiting: count('waiting'),
    total: parts.length,
  };
}

export type GoalStageAt = 'plan' | 'validation' | 'environments' | 'tail';

type GoalStageTone = 'green' | 'blue' | 'amber' | 'grey';

export interface GoalStage {
  at: GoalStageAt;
  label: string;
  reading: string;
  tone: GoalStageTone;
  done: number | null;
}

export function buildGoalStrip(page: GoalPageView): GoalStage[] {
  const stages: GoalStage[] = [planStage(page), validationStage(page)];
  if (page.environments.length > 0) stages.push(environmentStage(page));
  stages.push(tailStage(page));
  return stages;
}

function planStage(page: GoalPageView): GoalStage {
  const base = { at: 'plan', label: 'Plan' } as const;
  if (page.plan === null) return { ...base, reading: 'not drawn', tone: 'grey', done: null };
  if (page.plan.status === 'planning') return { ...base, reading: 'being drawn', tone: 'blue', done: null };
  if (page.plan.status === 'awaiting_approval')
    return { ...base, reading: 'waiting on you', tone: 'amber', done: null };
  if (page.plan.status === 'abandoned') return { ...base, reading: 'abandoned', tone: 'grey', done: null };

  const track = buildGoalTrack(page.parts);
  if (track.total === 0) return { ...base, reading: 'one pull request', tone: 'grey', done: null };
  return {
    ...base,
    reading: `${track.merged}/${track.total} parts merged`,
    tone: track.merged === track.total ? 'green' : track.held > 0 ? 'amber' : track.now > 0 ? 'blue' : 'grey',
    done: (track.merged / track.total) * 100,
  };
}

function validationStage(page: GoalPageView): GoalStage {
  const base = { at: 'validation', label: 'Validation' } as const;
  const v = page.issue.validation;
  if (v === null || v.total === 0) return { ...base, reading: 'no checks', tone: 'grey', done: null };
  const settled = v.passed + v.waived;
  return {
    ...base,
    reading: `${settled}/${v.total} settled`,
    tone: v.state === 'clear' ? 'green' : v.failed > 0 ? 'amber' : 'blue',
    done: (settled / v.total) * 100,
  };
}

function environmentStage(page: GoalPageView): GoalStage {
  const base = { at: 'environments', label: 'Shipped' } as const;
  const envs = page.environments;
  const reached = envs.filter((e) => e.status === 'reached');
  const furthest = reached[reached.length - 1];
  const done = (reached.length / envs.length) * 100;
  if (furthest !== undefined) {
    const watch = watchFold(page, furthest.environment);
    return {
      ...base,
      reading: `reached ${furthest.environment}${watch === null ? '' : ` · ${watch.said}`}`,
      tone: watch?.said === 'watch regressed' ? 'amber' : reached.length === envs.length ? 'green' : 'blue',
      done,
    };
  }
  const partial = envs.find((e) => e.status === 'partial');
  if (partial !== undefined) {
    return { ...base, reading: `${partial.environment} ${reachCount(partial)}`, tone: 'amber', done };
  }
  if (envs.some((e) => e.status === 'unknown')) return { ...base, reading: 'not known', tone: 'grey', done: null };
  return { ...base, reading: 'not shipped', tone: 'grey', done };
}

export function reachCount(env: GoalEnvironmentReachView): string {
  const count = `${env.landed}/${env.total}`;
  if (env.unplaced === 0) return count;
  const merges = env.unplaced === 1 ? 'merge' : 'merges';
  return `${count} · ${env.unplaced} ${merges} not on the integration branch`;
}

function watchFold(page: GoalPageView, environment: string): { said: string } | null {
  const window = page.watches.find((w) => w.environment === environment);
  if (window === undefined || window.checks.length === 0) return null;
  const verdicts = window.checks.map((c) => c.reading?.verdict ?? null);
  if (verdicts.includes('regressed')) return { said: 'watch regressed' };
  if (verdicts.some((v) => v !== 'clean')) return { said: 'watch not read' };
  return { said: 'watch clean' };
}

function tailStage(page: GoalPageView): GoalStage {
  const base = { at: 'tail', label: 'Close-out' } as const;
  const { issue } = page;
  if (issue.state !== 'open') return { ...base, reading: issue.state, tone: 'green', done: 100 };
  if (issue.shortfall) return { ...base, reading: 'fell short', tone: 'amber', done: null };
  if (issue.delivery) return { ...base, reading: 'delivered, ticket open', tone: 'blue', done: null };
  return { ...base, reading: 'not reached', tone: 'grey', done: null };
}

export const GOAL_SECTIONS = [
  'ticket',
  'validation',
  'localValidation',
  'remoteValidation',
  'signals',
  'sequence',
  'environments',
  'tail',
  'record',
] as const;

export type GoalSection = (typeof GOAL_SECTIONS)[number];

export function goalSectionsOpen(page: GoalPageView): Record<GoalSection, boolean> {
  return {
    ticket: !workStarted(page),
    validation: (shipped(page) && liveChecks(page) > 0) || page.checks.some((c) => c.state !== 'unrun'),
    localValidation: page.issue.localValidation !== null,
    remoteValidation: page.remoteSheets.length > 0,
    signals: (shipped(page) && page.signals.length > 0) || page.signals.some((s) => !s.live || s.proposal !== null),
    environments: page.environments.some((e) => e.status !== 'absent'),
    sequence: false,
    tail: tailBegun(page),
    record: false,
  };
}

function workStarted(page: GoalPageView): boolean {
  return page.plan !== null || page.openPullRequests.length > 0 || page.agents.length > 0;
}

function shipped(page: GoalPageView): boolean {
  return page.environments.some((e) => e.status === 'reached' || e.status === 'partial');
}

function liveChecks(page: GoalPageView): number {
  return page.checks.filter((c) => c.supersededReason === null).length;
}

function tailBegun(page: GoalPageView): boolean {
  const { issue } = page;
  return issue.state !== 'open' || Boolean(issue.delivery) || Boolean(issue.shortfall) || Boolean(issue.retrospective);
}

export const GOAL_TABS = ['ticket', 'work', 'validation', 'shipping', 'record'] as const;

export type GoalTab = (typeof GOAL_TABS)[number];

export const GOAL_TAB_LABEL: Record<GoalTab, string> = {
  ticket: 'Ticket',
  work: 'Work',
  validation: 'Validation',
  shipping: 'Shipping',
  record: 'Record',
};

/**
 * Which pane each foldable section lives behind. The page's own map rather than
 * the console's, because the track strip routes through it too: a strip stage
 * and the tab it belongs to must never disagree about where a stage is drawn.
 * → docs/spec/17-cockpit.md#the-panes
 */
export const GOAL_TAB_OF: Record<GoalSection, GoalTab> = {
  ticket: 'ticket',
  sequence: 'ticket',
  validation: 'validation',
  localValidation: 'validation',
  remoteValidation: 'validation',
  environments: 'shipping',
  signals: 'shipping',
  tail: 'record',
  record: 'record',
};

export interface GoalTabOpening {
  tab: GoalTab;
  why: string;
}

/**
 * Which pane the page opens on when the operator has not picked one, and the
 * sentence that says why. Read top to bottom, first answer wins: the order *is*
 * the rule, and each arm names a state some other surface already draws.
 *
 * It decides the landing only. The moment an operator picks a tab the pick is on
 * `Place` and this is not consulted again — a goal that lands in an environment
 * while somebody is reading its plan must not take the pane out from under them.
 * → docs/spec/17-cockpit.md#which-pane-opens
 */
export function goalTabOpening(page: GoalPageView): GoalTabOpening {
  if (settled(page)) return { tab: 'record', why: 'this goal is finished — the record is what the page is for now' };
  if (page.gateHold !== null) return { tab: 'shipping', why: 'a gate is holding this goal short of an environment' };
  if (page.openPullRequests.some((pr) => pr.attention.status === 'you'))
    return { tab: 'work', why: 'a pull request is in your court' };
  if (page.issue.validation?.state === 'flagged' || flaggedLocally(page))
    return { tab: 'validation', why: 'the validation plan is not settled' };
  if (shipped(page)) return { tab: 'shipping', why: 'the work has reached an environment' };
  if (validationBegun(page)) return { tab: 'validation', why: 'the work is merged and its checks have begun' };
  if (workStarted(page)) return { tab: 'work', why: 'there is a plan, a pull request or an agent on this goal' };
  return { tab: 'ticket', why: 'nothing has been planned yet, so the ask is the page' };
}

export interface GoalTabBadge {
  text: string;
  tone: 'green' | 'amber' | 'red' | 'blue' | null;
}

/**
 * What each tab carries on its own label: a count, and the tone the strip would
 * give the same reading. Null is a real answer and means the pane holds nothing
 * yet — a badge reading `0` says a thing was counted, which is not the same.
 * → docs/spec/17-cockpit.md#the-panes
 */
export function goalTabBadges(page: GoalPageView): Record<GoalTab, GoalTabBadge | null> {
  return {
    ticket: page.issue.instructions.length === 0 ? null : { text: `${page.issue.instructions.length}`, tone: null },
    work: workBadge(page),
    validation: validationBadge(page),
    shipping: shippingBadge(page),
    record: page.issue.spend === null ? null : { text: fmtCost(page.issue.spend.costUsd), tone: null },
  };
}

function workBadge(page: GoalPageView): GoalTabBadge | null {
  const wants = page.openPullRequests.filter((pr) => pr.attention.status === 'you').length;
  if (wants > 0) return { text: `${wants} in your court`, tone: 'red' };
  const track = buildGoalTrack(page.parts);
  if (track.total > 0) {
    const text = `${track.merged}/${track.total}`;
    if (track.merged === track.total) return { text, tone: 'green' };
    if (track.held > 0) return { text, tone: 'amber' };
    return { text, tone: track.now > 0 ? 'blue' : null };
  }
  const open = page.openPullRequests.length;
  return open === 0 ? null : { text: `${open} open`, tone: 'blue' };
}

function validationBadge(page: GoalPageView): GoalTabBadge | null {
  const v = page.issue.validation;
  if (v === null || v.total === 0) return flaggedLocally(page) ? { text: 'asked of you', tone: 'amber' } : null;
  const settledChecks = v.passed + v.waived;
  return {
    text: `${settledChecks}/${v.total}`,
    tone: v.state === 'clear' ? 'green' : v.failed > 0 ? 'red' : 'amber',
  };
}

function shippingBadge(page: GoalPageView): GoalTabBadge | null {
  if (page.gateHold !== null) return { text: 'gate held', tone: 'amber' };
  const envs = page.environments;
  if (envs.length === 0) return null;
  const reached = envs.filter((e) => e.status === 'reached').length;
  if (reached === 0) return envs.some((e) => e.status === 'partial') ? { text: 'partial', tone: 'amber' } : null;
  return { text: `${reached}/${envs.length}`, tone: reached === envs.length ? 'green' : 'blue' };
}

/* Two decimals under ten dollars and none over: the badge is a glance at what a
   goal has cost, and cents on a two-figure number are three characters of noise
   on a control that has to stay one line. */
function fmtCost(usd: number): string {
  return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

function settled(page: GoalPageView): boolean {
  const { issue } = page;
  return issue.state !== 'open' || issue.conclusion.verdict === 'done' || issue.run?.dismissed === true;
}

function flaggedLocally(page: GoalPageView): boolean {
  const local = page.issue.localValidation;
  return local !== null && (local.status === 'failed' || local.status === 'blocked');
}

function validationBegun(page: GoalPageView): boolean {
  return (
    page.checks.some((c) => c.supersededReason === null && c.state !== 'unrun') ||
    page.issue.localValidation !== null ||
    page.remoteSheets.length > 0
  );
}
