import type {
  Agent,
  AppState,
  GoalAgentsPayload,
  TaskSummary,
  CockpitDecision,
  Issue,
  OpenPullRequest,
  PlanPart,
  PlanView,
  PullRequest,
  EnvironmentGateRelease,
  FeatureSequence,
  GoalEnvironmentReachView,
  GoalLandingReach,
  GoalWatch,
  GoalWatchView,
  RemoteSheetView,
  ValidationCheckView,
  ValidationPlanRecord,
  ValidationResourceView,
} from '../types.js';
import type { NeedKind, NeedRow } from './needsYou.js';
import { inFlight, localValidationSaid } from './localValidation.js';

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
  plan: PlanView | null;
  parts: GoalPartView[];
  retiredParts: PlanPart[];
  openPullRequests: OpenPullRequest[];
  closedPullRequests: PullRequest[];
  agents: GoalAgentView[];
  decisions: CockpitDecision[];
  checks: ValidationCheckView[];
  /** The goal's validation plan record — the plan's hint, and the planner's account of the set. */
  checkPlan: ValidationPlanRecord | null;
  checkResources: ValidationResourceView[];
  environments: GoalEnvironmentReachView[];
  /** Every landing this goal owns, with each environment's verdict on it. */
  landings: GoalLandingReach[];
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
    checkPlan: (state.validationPlans ?? []).find((r) => r.originRef === ref) ?? null,
    checkResources: (state.validationResources ?? []).filter((r) => r.originRef === ref),
    environments: reach?.environments ?? [],
    landings: reach?.landings ?? [],
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

type GoalStageAt = 'plan' | 'validation' | 'environments' | 'tail';

type GoalStageTone = 'green' | 'blue' | 'amber' | 'grey';

interface GoalStage {
  at: GoalStageAt;
  label: string;
  reading: string;
  tone: GoalStageTone;
  done: number | null;
}

function planStage(page: GoalPageView): GoalStage {
  const base = { at: 'plan', label: 'Plan' } as const;
  /* A pull request waiting on the operator outranks how far the plan has got,
     because it is the one reading on this stage that is about them. The tab row
     said it and the track did not, and folding the two into one control is how a
     reading gets lost — so it is said here, where both now read from. */
  const court = page.openPullRequests.filter((pr) => pr.attention.status === 'you').length;
  if (court > 0) {
    return { ...base, reading: court === 1 ? '1 in your court' : `${court} in your court`, tone: 'amber', done: null };
  }
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
  const base = { at: 'validation', label: 'Merged' } as const;
  /* A local check plan that is running outranks the set's own count, because it
     is the only thing on the goal that is happening right now — and with the
     header's chip gone this is the one place outside the pane that says so. */
  const local = page.issue.localValidation;
  if (local !== null && inFlight(local)) {
    return { ...base, reading: localValidationSaid(local), tone: 'blue', done: null };
  }
  const v = page.issue.validation;
  if (v === null || v.total === 0) {
    if (flaggedLocally(page)) return { ...base, reading: 'flagged locally', tone: 'amber', done: null };
    return { ...base, reading: 'no checks', tone: 'grey', done: null };
  }
  const settled = v.passed + v.waived;
  return {
    ...base,
    reading: `${settled} of ${v.total} done`,
    tone: v.state === 'clear' ? 'green' : v.failed > 0 ? 'amber' : 'blue',
    done: (settled / v.total) * 100,
  };
}

function environmentStage(page: GoalPageView): GoalStage {
  const base = { at: 'environments', label: 'Shipped' } as const;
  const envs = page.environments;
  if (envs.length === 0) return { ...base, reading: 'no environments', tone: 'grey', done: null };
  if (page.gateHold !== null) return { ...base, reading: 'gate held', tone: 'amber', done: null };
  const reached = envs.filter((e) => e.status === 'reached');
  const furthest = reached[reached.length - 1];
  if (furthest !== undefined) {
    const watch = watchFold(page, furthest.environment);
    return {
      ...base,
      reading: `reached ${furthest.environment}${watch === null ? '' : ` · ${watch.said}`}`,
      tone: watch?.said === 'watch regressed' ? 'amber' : reached.length === envs.length ? 'green' : 'blue',
      /* The only denominator here that cannot grow: the environments are configuration,
         not plan. `total` below is `landings + unattributed + partsOwed`, so a meter drawn
         against it moves *backwards* the moment the plan decomposes further. */
      done: (reached.length / envs.length) * 100,
    };
  }
  /* Nothing has arrived, so there is nothing to check and nothing failing. A fraction here
     would read as a part-checked goal; what is true is that the goal is not checkable yet,
     and what an operator needs is what is still owed before it can be. */
  const partial = envs.find((e) => e.status === 'partial');
  if (partial !== undefined) {
    const owed = partial.total - partial.landed;
    return {
      ...base,
      /* Short enough to survive the tab's own width: the row ellipsizes, and a reading
         cut off mid-word is the reading lost. What it is owed *for* is the card below. */
      reading: owed === 1 ? '1 landing owed' : `${owed} landings owed`,
      tone: 'grey',
      done: null,
    };
  }
  if (envs.some((e) => e.status === 'unknown')) return { ...base, reading: 'not known', tone: 'grey', done: null };
  return { ...base, reading: 'not shipped', tone: 'grey', done: null };
}

/**
 * Every part of this goal has reached an environment. The only state in which a sheet,
 * a watch or a gate exists: `rollUpReach` answers `reached` only when every landing the
 * goal owes has been read as present, and `newArrivals` skips everything else.
 */
function arrived(page: GoalPageView): boolean {
  return page.environments.some((e) => e.status === 'reached');
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
  const base = { at: 'tail', label: 'Done' } as const;
  const { issue } = page;
  if (issue.state !== 'open') return { ...base, reading: issue.state, tone: 'green', done: 100 };
  if (issue.shortfall) return { ...base, reading: 'fell short', tone: 'amber', done: null };
  if (issue.delivery) return { ...base, reading: 'delivered, ticket open', tone: 'blue', done: null };
  return { ...base, reading: 'not reached', tone: 'grey', done: null };
}

export const GOAL_SECTIONS = [
  'ticket',
  'prediction',
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
  const live = livePageChecks(page);
  return {
    ticket: !workStarted(page),
    /* Open while the prediction is the live question — the plan is at its gate and
       marking it against what the plan says is the whole of what this pane is for —
       and again when delivery has landed and the second question is being asked.
       Between those it is a record of a moment that has passed, and an operator
       watching the work is reading past it to reach the parts. */
    prediction: !planUnderWay(page) || outcomeAsked(page),
    /* `live`, never `page.checks`: a superseded row is one the plan has already
       moved past, so a goal whose only started check was superseded has nothing
       live to show and the card opening on it reports work nobody can act on. */
    validation: (shipped(page) && live.length > 0) || live.some((c) => c.state !== 'unrun'),
    localValidation: page.issue.localValidation !== null,
    remoteValidation: page.remoteSheets.length > 0,
    signals: (shipped(page) && page.signals.length > 0) || page.signals.some((s) => !s.live || s.proposal !== null),
    environments: page.environments.some((e) => e.status !== 'absent'),
    sequence: false,
    tail: tailBegun(page),
    record: false,
  };
}

/**
 * Whether the plan has been approved and the work is under way. `planning` and
 * `awaiting_approval` are the two states in which nothing has been agreed yet, so
 * the prediction is still about a plan the operator is deciding on.
 *
 * @public the seam the goal page reads to place the prediction panel
 */
export function planUnderWay(page: GoalPageView): boolean {
  const status = page.plan?.status ?? null;
  return status !== null && status !== 'planning' && status !== 'awaiting_approval';
}

function outcomeAsked(page: GoalPageView): boolean {
  return page.needs.some((need) => need.kind === 'outcome');
}

function workStarted(page: GoalPageView): boolean {
  return page.plan !== null || page.openPullRequests.length > 0 || page.agents.length > 0;
}

function shipped(page: GoalPageView): boolean {
  return page.environments.some((e) => e.status === 'reached' || e.status === 'partial');
}

function livePageChecks(page: GoalPageView): ValidationCheckView[] {
  return page.checks.filter((c) => c.supersededReason === null);
}

function tailBegun(page: GoalPageView): boolean {
  const { issue } = page;
  return issue.state !== 'open' || Boolean(issue.delivery) || Boolean(issue.shortfall) || Boolean(issue.retrospective);
}

export const GOAL_TABS = ['ask', 'plan', 'merged', 'shipped', 'done'] as const;

export type GoalTab = (typeof GOAL_TABS)[number];

/* A tab's id is its label, lower case: the pane the label says is the pane
   `?pane=` names and the pane `GOAL_TAB_OF` maps a section to. The two drifted
   once — the row said "Checks" while every id under it said `validation` — and
   an id that disagrees with the word on the control is a rename nobody can grep
   for. → docs/spec/17-cockpit.md#the-panes */
const GOAL_TAB_LABEL: Record<GoalTab, string> = {
  ask: 'Ask',
  plan: 'Plan',
  merged: 'Merged',
  shipped: 'Shipped',
  done: 'Done',
};

/**
 * Which pane each foldable section lives behind. The page's own map rather than
 * the console's, because a press that names a card and the tab that card is
 * drawn behind must never disagree: a jump that landed on a card behind a pane
 * nobody had opened would be a control that appears to do nothing.
 * → docs/spec/17-cockpit.md#the-panes
 */
export const GOAL_TAB_OF: Record<GoalSection, GoalTab> = {
  ticket: 'ask',
  sequence: 'ask',
  prediction: 'plan',
  validation: 'merged',
  localValidation: 'merged',
  /* A sheet is assembled *for an arrival*, so it belongs with the arrival rather
     than with the checks that gate a merge. The two never coexist: nothing is
     sheeted until every part has landed.
     → docs/spec/24-environments.md#what-counts-as-a-landing */
  remoteValidation: 'shipped',
  environments: 'shipped',
  signals: 'shipped',
  tail: 'done',
  record: 'done',
};

/**
 * The pane the prediction card is drawn in — and with it the reveal gate, which
 * stands in the same card and asks the same record one moment earlier. Named once,
 * here beside the map the tabs read, so that a press that must land
 * on that card cannot end up naming a pane the card moved off.
 * → docs/spec/17-cockpit.md#the-panes
 */
export const PREDICTION_PANE: GoalTab = 'plan';

/**
 * The element id each stage of the track scrolls to, beside the pane map for the
 * same reason that map is here: a press that names a card and a press that names
 * the pane the card is drawn in must not be able to disagree.
 *
 * `plan` is the card the reveal gate stands in, which is why an ask on the rail can
 * name it — the ask is answered there and nowhere else.
 *
 * @public read by the goal page's own jumps and by the ask that leads to the gate
 */
export const GOAL_ANCHOR: Record<GoalStageAt, string> = {
  plan: 'cn-plan',
  validation: 'cn-validation',
  environments: 'cn-environments',
  tail: 'cn-tail',
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
  if (settled(page)) return { tab: 'done', why: 'this goal is finished — the record is what the page is for now' };
  if (page.gateHold !== null) return { tab: 'shipped', why: 'a gate is holding this goal short of an environment' };
  if (page.openPullRequests.some((pr) => pr.attention.status === 'you'))
    return { tab: 'plan', why: 'a pull request is in your court' };
  if (page.issue.validation?.state === 'flagged' || flaggedLocally(page))
    return { tab: 'merged', why: 'the check plan is not settled' };
  if (arrived(page)) return { tab: 'shipped', why: 'every part has reached an environment' };
  if (validationBegun(page)) return { tab: 'merged', why: 'the work is merged and its checks have begun' };
  if (workStarted(page)) return { tab: 'plan', why: 'there is a plan, a pull request or an agent on this goal' };
  return { tab: 'ask', why: 'nothing has been planned yet, so the ask is the page' };
}

export interface GoalLanding {
  ref: string;
  opening: GoalTabOpening;
}

/**
 * The landing this visit is holding, given the one it was holding before.
 *
 * {@link goalTabOpening} is a reading of live state, so a page that calls it on every
 * render has no landing at all: a pull request arriving in the operator's court, a
 * gate closing or an environment landing each re-answer it and move the pane out from
 * under whoever is reading. This is the "it decides the landing only" half of that
 * rule, held here rather than in the component so the holding *is* the tested part —
 * the component's `useRef` only carries the answer between renders.
 *
 * A different goal lands again, which is the point of keying on the ref. The sentence
 * is held with the tab, because a `why` re-read against a reading the tab no longer
 * answers is the title explaining a pane the operator is not on.
 * → docs/spec/17-cockpit.md#which-pane-opens
 */
export function goalLanding(held: GoalLanding | null, ref: string, page: GoalPageView): GoalLanding {
  if (held !== null && held.ref === ref) return held;
  return { ref, opening: goalTabOpening(page) };
}

/**
 * Which pane an ask belongs to, or null for one that is about the goal as a
 * whole rather than any stage of it. Total over {@link NeedKind}, like the
 * rail's own tables, so a new kind is placed deliberately rather than
 * inheriting whatever the last one meant.
 *
 * Every ask is drawn the same way — a row above the navigation — so what this
 * map decides is the dot: an ask with a pane puts one on that pane's nav entry,
 * and one about the goal as a whole puts none anywhere. The row says there is
 * something; the dot says which stage it is about.
 * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
 */
const GOAL_ASK_TAB: Record<NeedKind, GoalTab | null> = {
  assigned: 'plan',
  bench: 'plan',
  burn: 'plan',
  escalation: 'plan',
  merge: 'plan',
  describe: 'plan',
  permission: 'plan',
  plan: 'plan',
  reply: 'plan',
  validate: 'merged',
  validation_plan: 'merged',
  unwatched: 'shipped',
  watch: 'shipped',
  close_out: 'done',
  outcome: 'done',
  shortfall: 'done',
  /* About the goal itself, or about the fleet carrying it: neither has a stage
     to be drawn in, so neither carries a dot. */
  config: null,
  config_gap: null,
  dispatch: null,
  intake: null,
  limit: null,
  placement: null,
  profile: null,
  project_pull: null,
  recovery: null,
  supply: null,
  upgrade: null,
};

/** The asks a pane is about, which is what puts the dot on its nav entry. */
function goalPaneAsks(page: GoalPageView, tab: GoalTab): NeedRow[] {
  return page.needs.filter((row) => GOAL_ASK_TAB[row.kind] === tab);
}

interface GoalNavEntry {
  tab: GoalTab;
  label: string;
  reading: string;
  tone: GoalStageTone;
  done: number | null;
  /** An ask is waiting in this pane, which is what the dot on the entry says. */
  needsYou: boolean;
}

/**
 * The page's one navigation control. It was two — a track strip reading the
 * stages and a tab row badging the same numbers one line below it — and two
 * controls stating one thing is why the page read as cluttered. A stage is
 * where you go, so the stage is the button.
 *
 * Every entry is always drawn, including an environment stage for a goal with
 * no environments: a control that changes shape between goals cannot be aimed
 * at from memory. → docs/spec/17-cockpit.md#the-panes
 */
export function buildGoalNav(page: GoalPageView): GoalNavEntry[] {
  const stages: Record<Exclude<GoalTab, 'ask'>, GoalStage> = {
    plan: planStage(page),
    merged: validationStage(page),
    shipped: environmentStage(page),
    done: tailStage(page),
  };
  return GOAL_TABS.map((tab) => {
    const needsYou = goalPaneAsks(page, tab).length > 0;
    if (tab === 'ask') return { tab, label: GOAL_TAB_LABEL.ask, ...ticketReading(page), needsYou };
    const stage = stages[tab];
    return { tab, label: GOAL_TAB_LABEL[tab], reading: stage.reading, tone: stage.tone, done: stage.done, needsYou };
  });
}

/* The ticket is the only entry with no stage behind it: nothing about it
   progresses, so it reads what was asked for rather than how far it has got. */
function ticketReading(page: GoalPageView): { reading: string; tone: GoalStageTone; done: number | null } {
  const instructions = page.issue.instructions.length;
  if (instructions > 0) {
    return { reading: instructions === 1 ? '1 instruction' : `${instructions} instructions`, tone: 'blue', done: null };
  }
  return { reading: 'as filed', tone: 'grey', done: null };
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

/**
 * One cell of the reach matrix. `pending` is *not asked yet* — a part with no pull request, or a
 * landing no probe has read — and `unplaced` is a landing the clone says is on no integration
 * branch, which is **dropped from the goal's `total`** and never probed for rather than counted
 * against it. Neither may fold into `absent`, which is a probe that looked and did not find it.
 * → docs/spec/24-environments.md#the-three-verdicts, [what counts](../../../docs/spec/24-environments.md#what-counts-as-a-landing)
 */
export type GoalReachCell = 'reached' | 'absent' | 'unknown' | 'unplaced' | 'pending';

/** One row of the reach matrix: a plan part, or a merge no part claims. */
export interface GoalReachRow {
  key: string;
  kind: 'part' | 'unattributed';
  title: string;
  prNumber: number | null;
  cells: GoalReachCell[];
  /** On no integration branch: dropped from the goal's count rather than held against it. */
  unplaced: boolean;
}

interface GoalReachMatrixView {
  environments: string[];
  rows: GoalReachRow[];
  /** Landings still owed before any check can begin — the AND the rollup takes, said as work. */
  owed: number;
  /** An environment holds every landing this goal owes, so a sheet exists to read. */
  arrived: boolean;
}

/**
 * The goal's parts against the environments, one row each. The counts on
 * `GoalEnvironmentReachView` are the AND over these rows; this is the same reading with the
 * rows kept, which is what lets a partial goal say *which* landing is holding it short rather
 * than only how many are.
 *
 * It computes no verdict of its own — every cell is a status the server already shipped, and a
 * part with no landing is `pending` rather than a guess. → docs/spec/24-environments.md
 *
 * @public the seam the Shipped pane's matrix is drawn from
 */
export function buildGoalReachMatrix(page: GoalPageView): GoalReachMatrixView {
  const environments = page.environments.map((e) => e.environment);
  const byPr = new Map(page.landings.map((l) => [l.prNumber, l]));
  const claimed = new Set<number>();
  const rows: GoalReachRow[] = page.parts.map(({ part }) => {
    const landing = part.prNumber === null ? undefined : byPr.get(part.prNumber);
    if (landing !== undefined) claimed.add(landing.prNumber);
    return {
      key: part.id,
      kind: 'part' as const,
      title: part.title,
      prNumber: part.prNumber,
      cells: environments.map((name) => cellOf(landing, name)),
      unplaced: landing?.unplaced === true,
    };
  });
  for (const landing of page.landings) {
    if (claimed.has(landing.prNumber)) continue;
    /* A merge counted into `total` by `unattributedMerges` and named by no part. It holds the
       rollup exactly as a part does, so it is a row here — left as a footnote it would be a
       thing counted against the goal that appears nowhere on its page. */
    rows.push({
      key: `pr:${landing.prNumber}`,
      kind: 'unattributed',
      title: 'Merged against this goal, claimed by no part',
      prNumber: landing.prNumber,
      cells: environments.map((name) => cellOf(landing, name)),
      unplaced: landing.unplaced,
    });
  }
  const furthest = page.environments.find((e) => e.status === 'partial' || e.status === 'reached');
  return {
    environments,
    rows,
    owed: furthest === undefined ? 0 : furthest.total - furthest.landed,
    arrived: page.environments.some((e) => e.status === 'reached'),
  };
}

function cellOf(landing: GoalLandingReach | undefined, environment: string): GoalReachCell {
  if (landing === undefined) return 'pending';
  if (landing.unplaced) return 'unplaced';
  return landing.reach[environment] ?? 'pending';
}
