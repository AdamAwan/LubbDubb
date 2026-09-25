import type {
  Agent,
  AppState,
  CockpitEnvironment,
  GoalAgentsPayload,
  TaskSummary,
  CockpitDecision,
  Escalation,
  Issue,
  OpenPullRequest,
  PlanPart,
  PlanView,
  PullRequest,
  EnvironmentGateRelease,
  FeatureSequence,
  GoalEnvironmentReachView,
  GoalGroupReach,
  GoalLandingReach,
  GoalWatch,
  GoalWatchView,
  RemoteSheetView,
  ValidationCheckView,
  ValidationPlanRecord,
  ValidationResourceView,
} from '../types.js';
import type { NeedKind, NeedRow } from './needsYou.js';
import { belongsToGoal, closedPrs, goalIssue, ownsPr, reachesGoal } from './goalRefs.js';
import {
  closeStage,
  flaggedLocally,
  planStage,
  ticketReading,
  validationStage,
  watchStage,
  type GoalStage,
  type GoalStageTone,
} from './goalStages.js';

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
  /** The declared groups those rows are read in, rolled up on the server. */
  groups: GoalGroupReach[];
  /** Every landing this goal owns, with each environment's verdict on it. */
  landings: GoalLandingReach[];
  gateHold: string | null;
  gateRelease: EnvironmentGateRelease | null;
  remoteSheets: RemoteSheetView[];
  watches: GoalWatchView[];
  signals: GoalWatch[];
  sequence: FeatureSequence | null;
  /**
   * Which environment carries each obligation, from the deployment's own declaration rather
   * than this goal's reach rows. The tab row is the deployment's shape and must not change
   * between two goals on it. → docs/spec/17-cockpit.md#the-panes
   */
  obligations: GoalObligations;
}

/** The environments carrying each obligation, in promotion order. Empty where none does. */
type GoalObligations = Record<ObligationTab, string[]>;

/**
 * Who owes what, read off the environment list. An environment declares what arriving there
 * *means* — `arrival.opens` and a `watch` block — and that declaration is the whole of what
 * places an obligation, so a deployment that validates on test and watches production says so
 * in its config and nowhere else.
 *
 * An environment that carries more than one gate is named on each tab it carries: the tabs are
 * obligations, and one place can owe several.
 * → docs/spec/17-cockpit.md#the-panes
 *
 * @public the seam the goal page's tab row is derived from
 */
export function goalObligations(environments: readonly CockpitEnvironment[]): GoalObligations {
  return {
    validate: environments.filter((e) => e.opens.includes('validate')).map((e) => e.name),
    close: environments.filter((e) => e.opens.includes('close_out')).map((e) => e.name),
    watch: environments.filter((e) => e.watched).map((e) => e.name),
  };
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

export function buildGoalPage(
  state: AppState,
  ref: string,
  needs: readonly NeedRow[],
  history: GoalAgentsPayload | null = null,
): GoalPageView | null {
  const issue = goalIssue(state, ref);
  if (!issue) return null;

  const staffing = goalStaffing(state, ref, history);
  const plan = (state.plans ?? []).find((p) => p.originRef === ref) ?? null;
  const planParts = (state.planParts ?? []).filter((p) => plan !== null && p.planId === plan.id);
  const parts = goalParts(ref, planParts, staffing);
  const retiredParts = planParts.filter((p) => p.status === 'retired').sort((a, b) => a.seq - b.seq);

  const partPrs = new Set(
    [...parts.map((p) => p.part), ...retiredParts].flatMap((p) => (p.prNumber === null ? [] : [p.prNumber])),
  );

  return {
    issue,
    needs: needs.filter((n) => n.goalRef === ref),
    plan,
    parts,
    retiredParts,
    openPullRequests: state.world.pullRequests.filter((pr) => ownsPr(pr, issue, partPrs)),
    closedPullRequests: closedPrs(state).filter((pr) => ownsPr(pr, issue, partPrs)),
    agents: staffing.goalAgents.map<GoalAgentView>((agent) => {
      const origin = staffing.originOf(agent);
      const pr = origin === null ? null : /^pr:(\d+)$/.exec(origin);
      return {
        agent,
        onPr: pr === null ? null : Number(pr[1]),
        title: staffing.tasksById.get(agent.taskId)?.title ?? null,
      };
    }),
    ...goalCheckRecords(state, ref),
    ...goalReach(state, ref),
    ...goalWatchRecords(state, ref),
    sequence: goalSequence(state, issue),
    obligations: goalObligations(state.config.environments),
  };
}

interface GoalStaffing {
  tasksById: Map<string, TaskSummary>;
  originOf: (agent: Agent) => string | null;
  goalAgents: Agent[];
}

function goalStaffing(state: AppState, ref: string, history: GoalAgentsPayload | null): GoalStaffing {
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
  return { tasksById, originOf, goalAgents };
}

function goalParts(
  ref: string,
  planParts: readonly PlanPart[],
  { goalAgents, originOf }: GoalStaffing,
): GoalPartView[] {
  return planParts
    .flatMap<GoalPartView>((part) => {
      const group = GROUP_OF[part.status];
      if (!group) return [];
      const origins = new Set([`${ref}:part:${part.slug}`, ...(part.prNumber === null ? [] : [`pr:${part.prNumber}`])]);
      const on = goalAgents.filter((a) => origins.has(originOf(a) ?? ''));
      const agent = on.find((a) => a.endedAt === null) ?? on[0];
      return [{ part, group, agentId: agent?.id ?? null, agentLive: agent !== undefined && agent.endedAt === null }];
    })
    .sort((a, b) => a.part.seq - b.part.seq);
}

function goalCheckRecords(
  state: AppState,
  ref: string,
): Pick<GoalPageView, 'decisions' | 'checks' | 'checkPlan' | 'checkResources'> {
  return {
    decisions: state.decisions.filter((d) => belongsToGoal(d.subjectRef, ref)),
    checks: (state.validationChecks ?? []).filter((c) => c.originRef === ref),
    checkPlan: (state.validationPlans ?? []).find((r) => r.originRef === ref) ?? null,
    checkResources: (state.validationResources ?? []).filter((r) => r.originRef === ref),
  };
}

function goalReach(
  state: AppState,
  ref: string,
): Pick<GoalPageView, 'environments' | 'groups' | 'landings' | 'gateHold' | 'gateRelease'> {
  const reach = (state.environmentReach ?? []).find((e) => e.goalRef === ref);
  return {
    environments: reach?.environments ?? [],
    groups: reach?.groups ?? [],
    landings: reach?.landings ?? [],
    gateHold: reach?.gateHold ?? null,
    gateRelease: reach?.released ?? null,
  };
}

function goalWatchRecords(state: AppState, ref: string): Pick<GoalPageView, 'remoteSheets' | 'watches' | 'signals'> {
  return {
    remoteSheets: (state.remoteSheets ?? []).filter((s) => s.goalRef === ref),
    watches: (state.goalWatchWindows ?? []).filter((w) => w.goalRef === ref),
    signals: (state.goalWatches ?? []).filter((w) => w.originRef === ref),
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

export const GOAL_SECTIONS = [
  'prediction',
  'criteria',
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
    /* Open while the prediction is the live question — the plan is at its gate and
       marking it against what the plan says is the whole of what this pane is for —
       and again when delivery has landed and the second question is being asked.
       Between those it is a record of a moment that has passed, and an operator
       watching the work is reading past it to reach the parts. */
    prediction: !planUnderWay(page) || outcomeAsked(page),
    /* The page cannot answer this one: whether anybody has written criteria is the
       card's own read, not anything on the goal. So the default here is the widest
       the page can honestly give, and the card narrows it once its reading lands —
       which it may do only while the operator has not said, or it would be shutting
       a card they opened. → docs/spec/17-cockpit.md#goal-criteria-and-drift */
    criteria: true,
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

/**
 * The ask carrying this goal's plan verdict, while the plan has been read and is
 * still waiting on one — or null wherever there is nothing to decide here.
 *
 * It is read off the plan's own status and the escalation's `planId` rather than
 * off the row's kind alone, because a `plan` ask is also what a *change* to a
 * running plan is raised as, and that one is not the end of this sitting.
 *
 * `revealed` is a condition and not decoration: the verdict routes refuse a plan
 * nobody has revealed, so drawing the ask under the gate would put four answers
 * that each end in a refusal directly beneath the press that leads to the gate.
 * → docs/spec/17-cockpit.md#the-verdict-where-the-plan-was-read
 *
 * @public the seam the goal page reads to draw the verdict beside the plan
 */
export function planVerdictAsk(page: GoalPageView, escalations: readonly Escalation[]): NeedRow | null {
  return page.plan?.revealed === true ? planCardAsk(page, escalations) : null;
}

/**
 * The same ask while the plan card is answering it *in either way* — the gate
 * under a withheld plan, the verdict card under a revealed one.
 *
 * The two are one row and the card is where it is answered, so this is what the
 * page takes out of the asks it draws elsewhere. Read off `planVerdictAsk` alone
 * it would be dropped only after the reveal, and a withheld plan drew the ask
 * twice: a card at the top of the pane saying reveal it, and the gate itself a
 * few hundred pixels below, which is the guess the gate exists to prevent.
 * → docs/spec/17-cockpit.md#an-ask-is-the-loudest-thing-on-its-page
 */
function planCardAsk(page: GoalPageView, escalations: readonly Escalation[]): NeedRow | null {
  const plan = page.plan;
  if (plan === null || plan.status !== 'awaiting_approval') return null;
  return (
    page.needs.find((row) => {
      if (row.kind !== 'plan') return false;
      const planId = escalations.find((e) => e.id === row.id)?.context.planId;
      return typeof planId === 'string' && planId === plan.id;
    }) ?? null
  );
}

/**
 * The goal's asks, split into the ones the open pane owns and the ones that stay
 * a row above the navigation.
 *
 * An ask drawn in the pane it is about is drawn **in full**: the row was one line
 * of 13px over a pane whose own primary button is filled and three times its size,
 * and the control nothing is waiting on was winning every page. In its own pane
 * the ask is the pane's first card, so what needs the operator is what they read
 * first.
 *
 * Three rows are never in that set. The parent ask is drawn by the band at the
 * foot; the plan's verdict is drawn by the plan card, under the prediction; and an
 * ask about the goal as a whole — a profile answer, an intake, the fleet's own
 * config — belongs to no pane at all and can only be a row. Those keep the line,
 * which is why the line has to carry its own weight wherever it is drawn.
 * → docs/spec/17-cockpit.md#an-ask-is-the-loudest-thing-on-its-page
 *
 * @public the seam the goal page draws both sets from
 */
export function splitGoalAsks(
  page: GoalPageView,
  escalations: readonly Escalation[],
  tab: GoalTab,
): { inPane: NeedRow[]; lines: NeedRow[] } {
  /* Only on the pane the plan card is drawn in: elsewhere the card is not in front
     of the operator, and the row is the only thing saying the plan is waiting. */
  const onPlanCard = tab === 'plan' ? planCardAsk(page, escalations) : null;
  const inPane: NeedRow[] = [];
  const lines: NeedRow[] = [];
  for (const row of page.needs) {
    if (row.id.startsWith('placement:parent:')) continue;
    if (row.id === onPlanCard?.id) continue;
    (GOAL_ASK_TAB[row.kind] === tab ? inPane : lines).push(row);
  }
  return { inPane, lines };
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

export const GOAL_TABS = ['ask', 'plan', 'validate', 'close', 'watch'] as const;

export type GoalTab = (typeof GOAL_TABS)[number];

/**
 * The tabs that are obligations rather than places, in the order they come due. Each names the
 * environment that carries it, and a deployment that declares none still owes its checks and its
 * close-out.
 *
 * Subtracted from `GOAL_TABS` rather than listed a second time: a tab added to the row is an
 * obligation unless it is named here, so `GoalObligations` stops compiling until a new one is
 * placed on one side of that line deliberately. → docs/spec/17-cockpit.md#the-panes
 */
export type ObligationTab = Exclude<GoalTab, 'ask' | 'plan'>;

/* A tab's id is its label, lower case: the pane the label says is the pane
   `?pane=` names and the pane `GOAL_TAB_OF` maps a section to. The two drifted
   once — the row said "Checks" while every id under it said `validation` — and
   an id that disagrees with the word on the control is a rename nobody can grep
   for. → docs/spec/17-cockpit.md#the-panes */
const GOAL_TAB_LABEL: Record<GoalTab, string> = {
  ask: 'Ask',
  plan: 'Plan',
  validate: 'Validate',
  close: 'Close',
  watch: 'Watch',
};

/**
 * Which pane each foldable section lives behind. The page's own map rather than
 * the console's, because a press that names a card and the tab that card is
 * drawn behind must never disagree: a jump that landed on a card behind a pane
 * nobody had opened would be a control that appears to do nothing.
 * → docs/spec/17-cockpit.md#the-panes
 */
export const GOAL_TAB_OF: Record<GoalSection, GoalTab> = {
  sequence: 'ask',
  prediction: 'plan',
  criteria: 'plan',
  /* All three are the same obligation seen at three distances: the set of checks,
     the local run that answers some of them by hand, and the sheet an environment's
     run answers the rest from — a sheet row carries a check's `sourceId` and writes
     its outcome back onto that check. One list, so one pane.
     → docs/spec/36-remote-validation.md */
  validation: 'validate',
  localValidation: 'validate',
  remoteValidation: 'validate',
  /* Reaching an environment is what the close-out is owed against, and the record an
     operator reads when closing is beside it rather than a stage of its own. */
  environments: 'close',
  tail: 'close',
  record: 'close',
  signals: 'watch',
};

/**
 * The panes this deployment draws, in order. Every one but `watch` is always drawn — a
 * deployment with no environments still owes its checks and its close-out, and a row that
 * gained and lost columns between two goals could not be aimed at from memory. `watch` is
 * the one obligation nothing owes unless an environment declares a `watch` block, and a tab
 * for a window that can never open is a stage the goal can never reach.
 * → docs/spec/17-cockpit.md#the-panes
 */
export function goalPanes(page: GoalPageView): GoalTab[] {
  return GOAL_TABS.filter((tab) => tab !== 'watch' || page.obligations.watch.length > 0);
}

/**
 * The pane a section is actually drawn behind on *this* deployment. `GOAL_TAB_OF` says
 * where it belongs; this is that answer folded onto a pane the row draws. No card may
 * vanish because a deployment declared no watch — the signals are still the goal's, and
 * folded into `close` they land where an operator finishing a goal is already reading.
 * → docs/spec/17-cockpit.md#the-panes
 */
export function goalPaneOf(page: GoalPageView, section: GoalSection): GoalTab {
  const tab = GOAL_TAB_OF[section];
  return goalPanes(page).includes(tab) ? tab : 'close';
}

/**
 * The pane the prediction card is drawn in — and with it the reveal gate, which
 * stands in the same card and asks the same record one moment earlier. Named once,
 * here beside the map the tabs read, so that a press that must land
 * on that card cannot end up naming a pane the card moved off.
 * → docs/spec/17-cockpit.md#the-panes
 */
export const PREDICTION_PANE: GoalTab = 'plan';

/**
 * The element id each jumpable card carries, beside the pane map for the same reason
 * that map is here: a press that names a card and a press that names the pane the card
 * is drawn in must not be able to disagree.
 *
 * Keyed on the **card**, never on the tab: a pane holds several of these — `close` draws
 * the environments, the tail and the record — and an anchor keyed on the pane could only
 * name one of them. `plan` is the card the reveal gate stands in, which is why an ask on
 * the rail can name it: the ask is answered there and nowhere else.
 *
 * @public read by the goal page's own jumps and by the ask that leads to the gate
 */
export const GOAL_ANCHOR: Record<'plan' | 'validation' | 'environments' | 'tail', string> = {
  plan: 'cn-plan',
  validation: 'cn-validation',
  environments: 'cn-environments',
  tail: 'cn-tail',
};

/**
 * Which environment an obligation pane is showing. The operator's pick when it carries this
 * obligation — a pick made on one tab must not scope another tab to an environment that does
 * not owe it — then the furthest one this goal has reached, then the first declared.
 *
 * Null where no environment carries the obligation at all, which is the deployment saying
 * this one is a person's: the pane draws every goal-wide card and nothing environment-scoped.
 * → docs/spec/17-cockpit.md#the-panes
 *
 * @public the seam each obligation pane scopes its cards through
 */
export function obligationEnvironment(page: GoalPageView, tab: ObligationTab, picked: string | null): string | null {
  const names = page.obligations[tab];
  const reached = page.environments.filter((e) => e.status === 'reached').map((e) => e.environment);
  return names.find((n) => n === picked) ?? [...names].reverse().find((n) => reached.includes(n)) ?? names[0] ?? null;
}

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
  if (settled(page)) return { tab: 'close', why: 'this goal is finished — the record is what the page is for now' };
  if (page.gateHold !== null) return { tab: 'close', why: 'a gate is holding this goal short of an environment' };
  if (page.openPullRequests.some((pr) => pr.attention.status === 'you'))
    return { tab: 'plan', why: 'a pull request is in your court' };
  if (page.issue.validation?.state === 'flagged' || flaggedLocally(page))
    return { tab: 'validate', why: 'the check plan is not settled' };
  /* An arrival opens two obligations at once, and which of them is live is which one has
     something in it: the sheet is assembled *by* the arrival, so where there is one the
     checks are the question and the close-out is waiting on their answer. */
  if (arrived(page) && validationBegun(page))
    return { tab: 'validate', why: 'every part has arrived and its checks are what is outstanding' };
  if (arrived(page)) return { tab: 'close', why: 'every part has reached an environment' };
  if (validationBegun(page)) return { tab: 'validate', why: 'the work is merged and its checks have begun' };
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
 *
 * It is also what a press on the ask carries with it, so the pane the dot is on
 * and the pane the press lands on cannot disagree.
 * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
 */
export const GOAL_ASK_TAB: Record<NeedKind, GoalTab | null> = {
  assigned: 'plan',
  bench: 'plan',
  burn: 'plan',
  escalation: 'plan',
  merge: 'plan',
  describe: 'plan',
  description_wrong: 'plan',
  description_note: 'plan',
  permission: 'plan',
  plan: 'plan',
  reply: 'plan',
  validate: 'validate',
  validation_plan: 'validate',
  unwatched: 'watch',
  watch: 'watch',
  close_out: 'close',
  outcome: 'close',
  shortfall: 'close',
  /* About the goal itself, or about the fleet carrying it: neither has a stage
     to be drawn in, so neither carries a dot. */
  config: null,
  config_gap: null,
  dispatch: null,
  intake: null,
  sitting: 'plan',
  limit: null,
  placement: null,
  profile: null,
  project_pull: null,
  recovery: null,
  supply: null,
  upgrade: null,
};

/**
 * The asks a pane is about, which is what puts the dot on its nav entry. An ask whose pane
 * this deployment does not draw folds onto `close` exactly as its cards do — a dot nowhere
 * would be an ask the row never announces.
 */
function goalPaneAsks(page: GoalPageView, tab: GoalTab): NeedRow[] {
  const drawn = goalPanes(page);
  return page.needs.filter((row) => {
    const of = GOAL_ASK_TAB[row.kind];
    if (of === null) return false;
    return (drawn.includes(of) ? of : 'close') === tab;
  });
}

interface GoalNavEntry {
  tab: GoalTab;
  label: string;
  reading: string;
  tone: GoalStageTone;
  done: number | null;
  /** An ask is waiting in this pane, which is what the dot on the entry says. */
  needsYou: boolean;
  /**
   * The environments that carry this obligation, in promotion order — what the tab is
   * qualified by. Empty on `ask` and `plan`, which are nobody's obligation, and on an
   * obligation no environment opens: `validate` and `close` stand unqualified there, which
   * is the deployment saying the checks and the close-out are a person's.
   */
  on: string[];
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
    validate: validationStage(page),
    close: closeStage(page),
    watch: watchStage(page),
  };
  return goalPanes(page).map((tab) => {
    const needsYou = goalPaneAsks(page, tab).length > 0;
    const on = tab === 'ask' || tab === 'plan' ? [] : page.obligations[tab];
    if (tab === 'ask') return { tab, label: GOAL_TAB_LABEL.ask, ...ticketReading(page), needsYou, on };
    const stage = stages[tab];
    return {
      tab,
      label: GOAL_TAB_LABEL[tab],
      reading: stage.reading,
      tone: stage.tone,
      done: stage.done,
      needsYou,
      on,
    };
  });
}

function settled(page: GoalPageView): boolean {
  const { issue } = page;
  return issue.state !== 'open' || issue.conclusion.verdict === 'done' || issue.run?.dismissed === true;
}

function validationBegun(page: GoalPageView): boolean {
  return (
    page.checks.some((c) => c.supersededReason === null && c.state !== 'unrun') ||
    page.issue.localValidation !== null ||
    page.remoteSheets.length > 0
  );
}
