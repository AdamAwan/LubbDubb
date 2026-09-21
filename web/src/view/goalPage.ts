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
    groups: reach?.groups ?? [],
    landings: reach?.landings ?? [],
    gateHold: reach?.gateHold ?? null,
    gateRelease: reach?.released ?? null,
    remoteSheets: (state.remoteSheets ?? []).filter((s) => s.goalRef === ref),
    watches: (state.goalWatchWindows ?? []).filter((w) => w.goalRef === ref),
    signals: (state.goalWatches ?? []).filter((w) => w.originRef === ref),
    sequence: goalSequence(state, issue),
    obligations: goalObligations(state.config.environments),
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

type GoalStageTone = 'green' | 'blue' | 'amber' | 'grey';

interface GoalStage {
  reading: string;
  tone: GoalStageTone;
  done: number | null;
}

function planStage(page: GoalPageView): GoalStage {
  /* A pull request waiting on the operator outranks how far the plan has got,
     because it is the one reading on this stage that is about them. The tab row
     said it and the track did not, and folding the two into one control is how a
     reading gets lost — so it is said here, where both now read from. */
  const court = page.openPullRequests.filter((pr) => pr.attention.status === 'you').length;
  if (court > 0) {
    return { reading: court === 1 ? '1 in your court' : `${court} in your court`, tone: 'amber', done: null };
  }
  if (page.plan === null) return { reading: 'not drawn', tone: 'grey', done: null };
  if (page.plan.status === 'planning') return { reading: 'being drawn', tone: 'blue', done: null };
  if (page.plan.status === 'awaiting_approval') return { reading: 'waiting on you', tone: 'amber', done: null };
  if (page.plan.status === 'abandoned') return { reading: 'abandoned', tone: 'grey', done: null };

  const track = buildGoalTrack(page.parts);
  if (track.total === 0) return { reading: 'one pull request', tone: 'grey', done: null };
  return {
    reading: `${track.merged}/${track.total} parts merged`,
    tone: track.merged === track.total ? 'green' : track.held > 0 ? 'amber' : track.now > 0 ? 'blue' : 'grey',
    done: (track.merged / track.total) * 100,
  };
}

function validationStage(page: GoalPageView): GoalStage {
  /* A local check plan that is running outranks the set's own count, because it
     is the only thing on the goal that is happening right now — and with the
     header's chip gone this is the one place outside the pane that says so. */
  const local = page.issue.localValidation;
  if (local !== null && inFlight(local)) {
    return { reading: localValidationSaid(local), tone: 'blue', done: null };
  }
  const v = page.issue.validation;
  if (v === null || v.total === 0) {
    if (flaggedLocally(page)) return { reading: 'flagged locally', tone: 'amber', done: null };
    return { reading: 'no checks', tone: 'grey', done: null };
  }
  const settled = v.passed + v.waived;
  return {
    reading: `${settled} of ${v.total} done`,
    tone: v.state === 'clear' ? 'green' : v.failed > 0 ? 'amber' : 'blue',
    done: (settled / v.total) * 100,
  };
}

/**
 * One place the goal's work can be. A declared group stands for its members and an
 * environment in none stands for itself, in the order the environments are configured — so
 * three regions of production are one reading here rather than three, exactly as they are
 * one reading to the gate that waits on them.
 *
 * It computes no verdict: a group's status is the roll-up the server already shipped.
 * → docs/spec/24-environments.md#groups
 *
 * @public the seam the Environments card and the close-out's reading are drawn from
 */
export interface GoalReachBand {
  name: string;
  environments: string[];
  status: GoalEnvironmentReachView['status'];
  landed: number;
  total: number;
  grouped: boolean;
}

export function reachBands(page: GoalPageView): GoalReachBand[] {
  const byMember = new Map<string, GoalGroupReach>();
  for (const group of page.groups) for (const name of group.environments) byMember.set(name, group);
  const out: GoalReachBand[] = [];
  const drawn = new Set<string>();
  for (const env of page.environments) {
    const group = byMember.get(env.environment);
    if (group === undefined) {
      out.push({
        name: env.environment,
        environments: [env.environment],
        status: env.status,
        landed: env.landed,
        total: env.total,
        grouped: false,
      });
      continue;
    }
    if (drawn.has(group.group)) continue;
    drawn.add(group.group);
    out.push({
      name: group.group,
      environments: group.environments,
      status: group.status,
      landed: group.landed,
      total: group.total,
      grouped: true,
    });
  }
  return out;
}

/**
 * What the close-out is waiting on. It reads the delivery and the tail first — the obligation
 * this tab *is* — and falls back to the reach the close is owed against, because a goal that
 * has arrived nowhere is not a goal whose close-out is outstanding, it is one whose close-out
 * cannot be asked for yet. → docs/spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time
 */
function closeStage(page: GoalPageView): GoalStage {
  const { issue } = page;
  if (issue.state !== 'open') return { reading: issue.state, tone: 'green', done: 100 };
  if (issue.shortfall) return { reading: 'fell short', tone: 'amber', done: null };
  /* What wants a person outranks how far the work got: a held gate is the operator's to
     release, and nothing is filed while it holds. */
  if (page.gateHold !== null) return { reading: 'gate held', tone: 'amber', done: null };
  if (issue.delivery) return { reading: 'delivered, ticket open', tone: 'blue', done: null };
  return reachStage(page);
}

/* Counted in places rather than in commands: a goal that has reached one region of production
   has not reached production. → docs/spec/24-environments.md#groups */
function reachStage(page: GoalPageView): GoalStage {
  const envs = reachBands(page);
  if (envs.length === 0) return { reading: 'not reached', tone: 'grey', done: null };
  const reached = envs.filter((e) => e.status === 'reached');
  const furthest = reached[reached.length - 1];
  if (furthest !== undefined) {
    return {
      reading: `reached ${furthest.name}`,
      tone: reached.length === envs.length ? 'green' : 'blue',
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
      /* Short enough to survive the tab's own width: the row ellipsizes, and a reading
         cut off mid-word is the reading lost. What it is owed *for* is the card below. */
      reading: owed === 1 ? '1 landing owed' : `${owed} landings owed`,
      tone: 'grey',
      done: null,
    };
  }
  if (envs.some((e) => e.status === 'unknown')) return { reading: 'not known', tone: 'grey', done: null };
  return { reading: 'not shipped', tone: 'grey', done: null };
}

/**
 * The Watch tab's reading: the windows this deployment's watched environments opened, each
 * folded by {@link watchFold} and the worst of them taken. A goal with no window open yet reads
 * what is true of the signals instead — a window that never opened and one that opened and read
 * nothing are different answers. → docs/spec/17-cockpit.md#the-panes
 */
function watchStage(page: GoalPageView): GoalStage {
  const windows = page.watches.filter((w) => page.obligations.watch.includes(w.environment));
  const open = windows.filter((w) => w.checks.length > 0);
  if (open.length === 0) {
    const pending = page.signals.filter((s) => !s.live || s.proposal !== null).length;
    if (pending > 0) return { reading: `${pending} awaiting you`, tone: 'amber', done: null };
    if (page.signals.length === 0) return { reading: 'no signals', tone: 'grey', done: null };
    return { reading: 'not opened', tone: 'grey', done: null };
  }
  const said = open.map(watchFold);
  if (said.includes('regressed')) return { reading: 'regressed', tone: 'amber', done: null };
  if (said.some((s) => s !== 'clean')) return { reading: 'not read', tone: 'blue', done: null };
  const settled = open.every((w) => w.settledAt !== null);
  return { reading: settled ? 'clean' : 'clean so far', tone: 'green', done: settled ? 100 : null };
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

/**
 * One window's every check, folded to a word. The reduction is one-directional and that is the
 * whole of the care here: `regressed` first, then anything not `clean` reads *not read*, and only
 * a window whose every check came back clean says so. A reading with space for one word must never
 * fold an unread environment into an all-clear. → docs/spec/29-post-deploy-watch.md#in-the-cockpit
 */
function watchFold(window: GoalWatchView): 'regressed' | 'not read' | 'clean' {
  const verdicts = window.checks.map((c) => c.reading?.verdict ?? null);
  if (verdicts.includes('regressed')) return 'regressed';
  if (verdicts.some((v) => v !== 'clean')) return 'not read';
  return 'clean';
}

export const GOAL_SECTIONS = [
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
