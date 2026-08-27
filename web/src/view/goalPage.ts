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
  GoalEnvironmentReach,
  GoalWatchView,
  ValidationCheck,
  ValidationResourceView,
} from '../types.js';
import type { NeedRow } from './needsYou.js';

/**
 * Where a part stands, folded from `status` alone. Four groups rather than eight
 * statuses because the page is read as a sequence — what is done, what is moving,
 * what is stuck, what has not started — and `ready` versus `pending` is a
 * distinction the queue's own reason states better than a column heading can.
 */
export type PartGroup = 'merged' | 'now' | 'held' | 'waiting';

export interface GoalPartView {
  part: PlanPart;
  group: PartGroup;
  /** The agent that worked this part, live or finished, when there is one. */
  agentId: string | null;
  /**
   * And whether it is still going. Separate from {@link GoalPartView.agentId}
   * because the two answer different questions and the card draws both: a
   * finished agent is still the way to what happened here, and only a live one is
   * a claim that something is happening now. Folded into one field, a merged part
   * would pulse.
   */
  agentLive: boolean;
}

/**
 * One agent on the goal's page, and how the goal reaches it.
 *
 * `onPr` is the pull request the dispatch actually named, on the agents this goal
 * owns *through* one — a CI fix, a review round, a retarget. Null on the agents
 * dispatched at the goal's own subtree.
 *
 * The two are drawn in one list because they are one answer to "who is working
 * this": a pull request is opened for a goal and closed for a goal, so an agent on
 * it is an agent on the goal. They are still told apart, and both readings are
 * load-bearing — the row names the pull request as a way there, and ending the run
 * counts only the subtree, which is the only thing `clearGoalWork` kills
 * ([16](../../../docs/spec/16-http-api.md#post-apiissuesnumberdismiss-run)).
 */
interface GoalAgentView {
  agent: Agent;
  /** The pull request the dispatch named, or null when it named the goal's own subtree. */
  onPr: number | null;
  /**
   * What it was sent to do, from whichever list carries its task.
   *
   * Resolved here rather than through `view.taskFor` at the call site, because
   * half these rows are older than the snapshot's bounded fleet list: a title
   * looked up there would go blank on exactly the runs this page fetched its own
   * history to show.
   */
  title: string | null;
}

/** The overview's five-segment reading of a goal. */
export interface GoalTrack {
  merged: number;
  now: number;
  held: number;
  waiting: number;
  total: number;
}

export interface GoalPageView {
  issue: Issue;
  /** This goal's open asks, already ordered by {@link buildNeedsYou}. */
  needs: NeedRow[];
  plan: Plan | null;
  parts: GoalPartView[];
  /**
   * The parts the plan no longer schedules, in the order it declared them.
   *
   * Held apart from `parts` rather than folded in as a fifth group, because every
   * count on the page and the overview's segment track are reads of `parts` and a
   * retired part is not one of the goal's: it is what the plan *proposed*. Drawn
   * all the same, because what an amendment dropped is half of what the plan's
   * record is for — a goal whose part list shrank between two readings otherwise
   * simply lost rows, with nothing saying so.
   */
  retiredParts: PlanPart[];
  openPullRequests: OpenPullRequest[];
  closedPullRequests: PullRequest[];
  agents: GoalAgentView[];
  /** This goal's own slice of the decision log, newest first as the server ordered it. */
  decisions: CockpitDecision[];
  /**
   * How anyone checks this goal was met, superseded checks included — drawing what
   * an amended plan withdrew is half of what the record is for.
   *
   * They reach the page directly off the goal ref rather than through `plan`,
   * because that is what a check now hangs from: a verdict is keyed on the goal,
   * not on the plan that proposed it ([20](../../../docs/spec/20-validation.md)).
   * Routing them through the plan would lose every check on a goal whose plan was
   * abandoned — the case where an operator most needs to know what was never run.
   */
  checks: ValidationCheck[];
  /** The checks' declared resources, each already resolved to a path and a present/missing fact. */
  checkResources: ValidationResourceView[];
  /**
   * Where this goal's landed work has got to, one entry per configured
   * environment. **Empty means "no environments configured"**, and the page draws
   * nothing at all for it — a goal that has landed nothing yet still gets a row per
   * environment, saying so.
   */
  environments: GoalEnvironmentReach[];
  /**
   * Why this goal's validation and close-out rows are being withheld, or null
   * when nothing is withholding them. Server-made, so the sentence the page draws
   * and the decision the desks took are the same one.
   */
  gateHold: string | null;
  /** The operator's standing "this one is not waiting on an environment". */
  gateRelease: EnvironmentGateRelease | null;
  /**
   * The post-deploy watch, one entry per environment this goal's work arrived in.
   *
   * **Empty means nothing is being watched**, and the page draws no watch surface
   * at all — not an empty block, not a row of question marks. A goal that declared
   * no checks, and a deployment where no environment declares a `watch`, both read
   * as this, because null is a third fact rather than a synonym for clean.
   * → `docs/spec/29-post-deploy-watch.md#in-the-cockpit`
   */
  watches: GoalWatchView[];
}

/**
 * Whether `candidate` names this goal or something under it (`issue:1:part:x`),
 * not merely a ref that shares its digits as a prefix — `startsWith` alone
 * matches `issue:14` against `issue:1`, pulling another goal's agents and
 * decisions onto this page.
 */
function belongsToGoal(candidate: string | null | undefined, ref: string): boolean {
  return candidate === ref || (candidate?.startsWith(`${ref}:`) ?? false);
}

/**
 * Whether a dispatch's origin reaches this goal — its own subtree
 * (`issue:12:part:signer`), or a pull request that is one of the goal's.
 *
 * The two arms are one answer to "who is working this": a pull request is opened
 * for a goal, so an agent dispatched at one is an agent on the goal. The second
 * arm goes through {@link goalOfPr} rather than off the branch, which is the same
 * three-way match the pull-request card is drawn with.
 */
function reachesGoal(state: AppState, origin: string | null, ref: string): boolean {
  if (belongsToGoal(origin, ref)) return true;
  const pr = origin === null ? null : /^pr:(\d+)$/.exec(origin);
  return pr !== null && goalOfPr(state, Number(pr[1])) === ref;
}

/**
 * The pull requests this goal owns, by number — what the goal page names when it
 * asks the server for the goal's whole run history.
 *
 * It is {@link reachesGoal}'s second arm run backwards over the world rather than
 * a fourth way of matching a pull request to a goal, so the agents the route
 * selects are the ones this page would have kept anyway. The plan's own part
 * numbers are unioned in because a part's pull request merged months ago is
 * outside both world lists, and its run is exactly the history the fetch is for.
 */
export function goalPrNumbers(state: AppState, ref: string): number[] {
  const plan = (state.plans ?? []).find((p) => p.originRef === ref) ?? null;
  const parts = plan === null ? [] : (state.planParts ?? []).filter((p) => p.planId === plan.id).map((p) => p.prNumber);
  const world = [...state.world.pullRequests, ...(state.world.closedPullRequests ?? [])];
  return [
    ...new Set([
      ...parts.flatMap((n) => (n === null ? [] : [n])),
      ...world.filter((pr) => goalOfPr(state, pr.number) === ref).map((pr) => pr.number),
    ]),
  ];
}

/**
 * Whether this pull request is one of the goal's.
 *
 * Three ways, and the part rows are only the first of them. A goal the funnel
 * failed open on has no parts at all and its pull request is on the flat
 * `issue/<n>` branch, so a page keyed on `prNumber` alone drew nothing for it. The
 * other two are the server's own matching, in `resolveIssuePr`: the branch
 * convention (`issue/<n>`, and `issue/<n>/<slug>` for a part whose row has not
 * caught up), and `linkedPrNumber` for a PR the provider linked itself. The convention is restated here rather than imported because the
 * cockpit names `src/wire.ts` and nothing else; it is a *string shape*, not a
 * verdict, and the pair is pinned by `test/goalPage.test.ts`.
 */
function ownsPr(pr: PullRequest, issue: Issue, partPrs: ReadonlySet<number>): boolean {
  const ref = `issue:${issue.number}`;
  return partPrs.has(pr.number) || pr.number === issue.linkedPrNumber || branchGoal(pr.branch) === ref;
}

/**
 * The goal a branch name declares, as `issue:<n>` — `issue/12` and
 * `issue/12/signer` both, and nothing else. One implementation of the convention,
 * because it is read in two directions: from a goal, to find its pull requests
 * ({@link ownsPr}); and from a pull request, to find the goal an ask raised on it
 * belongs to ({@link goalOfPr}). Two readings of one string shape is how
 * `issue/14` ends up matching `issue:1`.
 */
function branchGoal(branch: string): string | null {
  const m = /^issue\/(\d+)(?:\/|$)/.exec(branch);
  return m ? `issue:${m[1]}` : null;
}

/**
 * The goal a pull request belongs to, as `issue:<n>`, or null when no ticket owns
 * it. The same three ways {@link ownsPr} matches, read backwards — a PR row, a
 * `linkedPrNumber`, or the branch convention.
 *
 * Null is a real answer, not a lookup failure: the harness works ticketless pull
 * requests as first-class subjects ([05](../../../docs/spec/05-dispatcher.md)), so
 * an ask raised on one has no goal to be read next to, and the surface that draws
 * it must say so rather than imply a goal it cannot name.
 *
 * @public shared with buildNeedsYou, which routes a PR-origin ask by it
 */
export function goalOfPr(state: AppState, prNumber: number): string | null {
  const part = (state.planParts ?? []).find((p) => p.prNumber === prNumber);
  const plan = part ? (state.plans ?? []).find((pl) => pl.id === part.planId) : undefined;
  if (plan) return plan.originRef;

  const linked = state.world.issues.find((i) => i.linkedPrNumber === prNumber);
  if (linked) return `issue:${linked.number}`;

  const pr = [...state.world.pullRequests, ...(state.world.closedPullRequests ?? [])].find(
    (p) => p.number === prNumber,
  );
  return pr ? branchGoal(pr.branch) : null;
}

/**
 * The goal a dispatch was raised against, as `issue:<n>` — the origin ref read
 * through whichever of the two shapes it wears.
 *
 * A dispatch names a goal directly (`issue:390`, and the part refs built on it) or
 * names a pull request (`pr:412`), and only the first is a goal ref already. Both
 * mean "somebody is working this goal", so a surface that reads only the first
 * shape says nothing is happening on every goal whose work has reached a pull
 * request — which is most of the ones being worked.
 *
 * Null when the origin is a ticketless pull request, which is a real answer for
 * the same reason it is in {@link goalOfPr}.
 *
 * @public shared with buildViewModel's agentOnGoal
 */
export function goalOfOrigin(state: AppState, originRef: string | null): string | null {
  if (originRef === null) return null;
  const issue = /^issue:(\d+)/.exec(originRef);
  if (issue) return `issue:${issue[1]}`;
  const pr = /^pr:(\d+)$/.exec(originRef);
  return pr ? goalOfPr(state, Number(pr[1])) : null;
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
 * The issue a goal ref names — the world's copy, or a run the harness retained
 * after the ticket left the world. Undefined for a ref with no goal behind it.
 *
 * Exported because *whether a ref has a page* is what decides where a queue row
 * goes ({@link NeedRow.opens}), and asking that question a second way is exactly
 * how a row ends up opening a page that renders nothing.
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

/**
 * Everything one goal's page draws, assembled from the snapshot. Null for a ref
 * the world does not carry: a page of empty sections is indistinguishable from a
 * goal that exists and has nothing on it, and only one of those is worth drawing.
 *
 * `needs` is passed in rather than rebuilt so the rail and the page are one
 * reading — answering on either settles the row and the next snapshot clears both.
 */
export function buildGoalPage(
  state: AppState,
  ref: string,
  needs: readonly NeedRow[],
  /**
   * The goal's fetched run history, when the page has one. Defaulted rather than
   * required because the page is whole without it: it adds the runs older than the
   * snapshot's bounded fleet list, and the callers that draw a fold over the plan
   * (the backlog row, the demo's work graph) have no use for them.
   */
  history: GoalAgentsPayload | null = null,
): GoalPageView | null {
  const issue = goalIssue(state, ref);
  if (!issue) return null;

  // Every agent this goal has had, from the two lists that each hold half of it.
  //
  // The snapshot's `agents` is the fleet's live rows and a bounded tail of ended
  // ones, so it always has what is happening now and usually not what happened in
  // March; `history` is this goal's whole record, fetched when the page opened and
  // therefore blind to anything dispatched since. Neither is the answer on its
  // own, and the union is — deduped by id, because the recent runs are in both.
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
  // Newest first, which is the order the snapshot's own list arrives in and what
  // every reader below assumes: the first match for a part is its last run.
  const goalAgents = [...onGoal.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const plan = (state.plans ?? []).find((p) => p.originRef === ref) ?? null;
  const parts = (state.planParts ?? [])
    .filter((p) => plan !== null && p.planId === plan.id)
    .flatMap<GoalPartView>((part) => {
      const group = GROUP_OF[part.status];
      if (!group) return [];
      // Two origins reach one part: the part itself, and the pull request it
      // opened — a CI fix or a review round is dispatched at `pr:<n>` and is as
      // much somebody's hands on this part as the build agent was. Read off the
      // part alone, a part whose work has reached review draws no agent at all,
      // which is most of the ones being worked.
      const origins = new Set([`${ref}:part:${part.slug}`, ...(part.prNumber === null ? [] : [`pr:${part.prNumber}`])]);
      const on = goalAgents.filter((a) => origins.has(originOf(a) ?? ''));
      // Live first, newest otherwise: the snapshot is newest-first, so the second
      // arm is the last run of this part and the first is what is happening now.
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

  // One lookup for the three environment fields: the row, why its obligations are
  // held, and the operator's answer if they lifted it.
  const reach = (state.environmentReach ?? []).find((e) => e.goalRef === ref);

  return {
    issue,
    needs: needs.filter((n) => n.goalRef === ref),
    plan,
    parts,
    retiredParts,
    openPullRequests: state.world.pullRequests.filter((pr) => ownsPr(pr, issue, partPrs)),
    closedPullRequests: (state.world.closedPullRequests ?? []).filter((pr) => ownsPr(pr, issue, partPrs)),
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
    // Equality, not `belongsToGoal`: a check is keyed on the goal itself, and
    // matching descendants would pull a part's ref in as though it were one.
    checks: (state.validationChecks ?? []).filter((c) => c.originRef === ref),
    checkResources: (state.validationResources ?? []).filter((r) => r.originRef === ref),
    environments: reach?.environments ?? [],
    gateHold: reach?.gateHold ?? null,
    gateRelease: reach?.released ?? null,
    watches: (state.goalWatchWindows ?? []).filter((w) => w.goalRef === ref),
  };
}

/**
 * The furthest environment this goal's whole work has reached, or null when it
 * has not been confirmed anywhere.
 *
 * **Furthest is last-declared, not best.** The operator's list is the order the
 * work travels in — `testUk`, `liveUk`, `liveEu`, `liveUs` — so the last one
 * confirmed is the one worth a word on a row that has space for one. Sorting by
 * anything else would need the harness to have an opinion about which environment
 * matters most, which is exactly the opinion it does not have.
 *
 * `partial` and `unknown` are not furthest anything: half a goal in production is
 * the state that most wants somebody, and a row saying "liveUs" for it would be
 * the boolean rollup `goalReach` refuses to make, one layer up.
 */
export function furthestEnvironment(state: AppState, goalRef: string): string | null {
  const reach = (state.environmentReach ?? []).find((e) => e.goalRef === goalRef);
  const reached = (reach?.environments ?? []).filter((e) => e.status === 'reached');
  return reached.length === 0 ? null : (reached[reached.length - 1]?.environment ?? null);
}

/**
 * The overview's track, folded off the page's own groups rather than off `status`
 * a second time — which is what stops the row and the page disagreeing about
 * whether a part is held or merely not started.
 */
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

/**
 * Which of the goal page's sections a track stage points at. A name rather than
 * an element id, because *where a reading lives on the page* is the page's
 * business and this module has no business knowing what it called the `<section>`.
 */
export type GoalStageAt = 'plan' | 'validation' | 'environments' | 'tail';

/** A tone the console already declares as a `cn-t-*` alias. No stage invents a colour. */
type GoalStageTone = 'green' | 'blue' | 'amber' | 'grey';

/**
 * One stage of the goal's track — a stretch of the pipeline, with the reading
 * that says how far through it the goal is.
 */
export interface GoalStage {
  at: GoalStageAt;
  /** The stage's own name, as the section it points at calls it. */
  label: string;
  /** How far through, in the words that section uses. Never a verdict of its own. */
  reading: string;
  tone: GoalStageTone;
  /**
   * How far through as a proportion, or **null when there is nothing to measure**.
   *
   * Null is a third reading and not a synonym for zero: a goal with no validation
   * plan has no checks outstanding, and a bar drawn empty for it would say every
   * check is still to run. The same distinction `ValidationVerdict` makes one
   * layer down, and the same one `GoalReachStatus` makes for an environment.
   */
  done: number | null;
}

/**
 * The goal's track: the pipeline in four stretches, each a way to the section that
 * owns it.
 *
 * **Every reading here is one the page already draws further down.** The strip
 * computes no verdict of its own — it folds `parts`, `issue.validation`,
 * `environments` and the tail's own fields, which is what stops the top of the
 * page disagreeing with the card it points at. That disagreement is the fault the
 * strip replaces: the merged count, the settled count, the reach and the ticket
 * state were four readings in four places, and answering "where has this goal got
 * to" meant scrolling past all of them.
 *
 * The environments stage is **absent** when no environment is configured, exactly
 * as the card is — a stage of question marks on a deployment that never set one up
 * would be a feature announcing itself as broken.
 */
export function buildGoalStrip(page: GoalPageView): GoalStage[] {
  const stages: GoalStage[] = [planStage(page), validationStage(page)];
  if (page.environments.length > 0) stages.push(environmentStage(page));
  stages.push(tailStage(page));
  return stages;
}

/**
 * The plan, and how much of it has landed.
 *
 * A plan that is not yet approved reads as its own status rather than as
 * "0/0 merged": the parts do not exist until it is, so a proportion would be a
 * measurement of nothing.
 */
function planStage(page: GoalPageView): GoalStage {
  const base = { at: 'plan', label: 'Plan' } as const;
  if (page.plan === null) return { ...base, reading: 'not drawn', tone: 'grey', done: null };
  if (page.plan.status === 'planning') return { ...base, reading: 'being drawn', tone: 'blue', done: null };
  if (page.plan.status === 'awaiting_approval')
    return { ...base, reading: 'waiting on you', tone: 'amber', done: null };
  if (page.plan.status === 'abandoned') return { ...base, reading: 'abandoned', tone: 'grey', done: null };

  const track = buildGoalTrack(page.parts);
  // A single-PR plan is a first-class outcome of the funnel with no parts at all,
  // so "0 parts" is the shape of the plan rather than work outstanding.
  if (track.total === 0) return { ...base, reading: 'one pull request', tone: 'grey', done: null };
  return {
    ...base,
    reading: `${track.merged}/${track.total} parts merged`,
    tone: track.merged === track.total ? 'green' : track.held > 0 ? 'amber' : track.now > 0 ? 'blue' : 'grey',
    done: (track.merged / track.total) * 100,
  };
}

/**
 * The checks, settled against live. `failed` is what earns amber — a plan whose
 * checks are merely unrun is in progress, and drawing that as a warning would make
 * the tone meaningless on the goals that have actually gone wrong.
 */
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

/**
 * How far the landed work has travelled.
 *
 * `unknown` is answered before "not shipped" and in its own words, because the
 * two are the reading this stage most needs to keep apart: a probe that could not
 * say and work that genuinely has not moved look identical once folded together,
 * and only one of them is about deployment.
 * → docs/spec/24-environments.md#the-three-verdicts
 */
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
    return { ...base, reading: `${partial.environment} ${partial.landed}/${partial.total}`, tone: 'amber', done };
  }
  if (envs.some((e) => e.status === 'unknown')) return { ...base, reading: 'not known', tone: 'grey', done: null };
  return { ...base, reading: 'not shipped', tone: 'grey', done };
}

/**
 * What the watch on one environment says, in the three words the card below draws
 * it in — or **null where nothing is being watched there**.
 *
 * Folded off the page's own `watches` rather than computed a second time, which is
 * the strip's existing rule: a stage that re-derived a verdict would be free to
 * disagree with the card it points at.
 *
 * This is the one place a watch is reduced to a word, and the reduction is
 * one-directional on purpose. `unknown` is answered before `clean` — a check
 * nobody could read is never folded into an all-clear, on the row that has space
 * for one reading — and the card underneath still draws every check, because a
 * goal whose signal passed and whose measure failed is a fix that worked and a
 * proc that is still slow.
 */
function watchFold(page: GoalPageView, environment: string): { said: string } | null {
  const window = page.watches.find((w) => w.environment === environment);
  if (window === undefined || window.checks.length === 0) return null;
  const verdicts = window.checks.map((c) => c.reading?.verdict ?? null);
  if (verdicts.includes('regressed')) return { said: 'watch regressed' };
  if (verdicts.some((v) => v !== 'clean')) return { said: 'watch not read' };
  return { said: 'watch clean' };
}

/**
 * What is left once the parts are in: whether anything checked the goal itself,
 * and whether the ticket is shut.
 *
 * No proportion — the tail is three unlike things rather than a count of one
 * thing, so the honest answer to "how far through" is that there is nothing to
 * measure.
 */
function tailStage(page: GoalPageView): GoalStage {
  const base = { at: 'tail', label: 'Close-out' } as const;
  const { issue } = page;
  if (issue.state !== 'open') return { ...base, reading: issue.state, tone: 'green', done: 100 };
  if (issue.shortfall) return { ...base, reading: 'fell short', tone: 'amber', done: null };
  if (issue.delivery) return { ...base, reading: 'delivered, ticket open', tone: 'blue', done: null };
  return { ...base, reading: 'not reached', tone: 'grey', done: null };
}
