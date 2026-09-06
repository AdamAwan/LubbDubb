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
  GoalEnvironmentReach,
  GoalWatch,
  GoalWatchView,
  ValidationCheck,
  ValidationResourceView,
} from '../types.js';
import type { NeedRow } from './needsYou.js';

/** Where a part stands, folded from `status` alone. Four groups rather than eight statuses. */
export type PartGroup = 'merged' | 'now' | 'held' | 'waiting';

export interface GoalPartView {
  part: PlanPart;
  group: PartGroup;
  /** The agent that worked this part, live or finished, when there is one. */
  agentId: string | null;
  /** Whether it is still going. A finished agent is still the way to what happened here. */
  agentLive: boolean;
}

/**
 * One agent on the goal's page, and how the goal reaches it. Ending the run counts **only the
 * subtree**, which is all `clearGoalWork` kills ([16](../../../docs/spec/16-http-api.md#post-apiissuesnumberdismiss-run)).
 */
interface GoalAgentView {
  agent: Agent;
  /** The pull request the dispatch named, or null when it named the goal's own subtree. */
  onPr: number | null;
  /** What it was sent to do, resolved here rather than through `view.taskFor` since older rows go blank there. */
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
  /** The parts the plan no longer schedules, in declared order — drawn separately so a shrinking part list doesn't silently lose rows. */
  retiredParts: PlanPart[];
  openPullRequests: OpenPullRequest[];
  closedPullRequests: PullRequest[];
  agents: GoalAgentView[];
  /** This goal's own slice of the decision log, newest first as the server ordered it. */
  decisions: CockpitDecision[];
  /** How anyone checks this goal was met, superseded checks included. Read off the goal ref, **never through `plan`** — a verdict is keyed on the goal ([20](../../../docs/spec/20-validation.md)). */
  checks: ValidationCheck[];
  /** The checks' declared resources, each already resolved to a path and a present/missing fact. */
  checkResources: ValidationResourceView[];
  /** Where this goal's landed work has got to, one entry per configured environment. Empty means no environments configured. */
  environments: GoalEnvironmentReach[];
  /** Why this goal's validation and close-out rows are withheld, or null. Server-made, so drawn sentence and desk decision are one. */
  gateHold: string | null;
  /** The operator's standing "this one is not waiting on an environment". */
  gateRelease: EnvironmentGateRelease | null;
  /** The post-deploy watch, one entry per environment this goal's work arrived in. Empty means nothing is being watched. → `docs/spec/29-post-deploy-watch.md#in-the-cockpit` */
  watches: GoalWatchView[];
  /**
   * What this goal declared a running system would have to show — the **declarations**, not the
   * readings ({@link GoalPageView.watches}), so they exist from plan submission. Empty draws no card.
   */
  signals: GoalWatch[];
  /** The accepted order holding this story, from the Feature it hangs off — null for no parent, unsequenced, or unaccepted alike. */
  sequence: FeatureSequence | null;
}

/**
 * Whether `candidate` names this goal or something under it (`issue:1:part:x`), not merely a ref
 * sharing its digits — plain `startsWith` matches `issue:14` against `issue:1`.
 */
function belongsToGoal(candidate: string | null | undefined, ref: string): boolean {
  return candidate === ref || (candidate?.startsWith(`${ref}:`) ?? false);
}

/** Whether a dispatch's origin reaches this goal — its own subtree, or a pull request that is one of the goal's ({@link goalOfPr}). */
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

/** The pull requests this goal owns, by number. Plan part numbers are unioned in since a merged part's PR can be outside both world lists. */
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

/**
 * Whether this pull request is one of the goal's — three ways: a plan part row, the branch
 * convention, or `linkedPrNumber`, mirroring the server's `resolveIssuePr`. Restated rather than
 * imported since the cockpit names `src/wire.ts` and nothing else; pinned by `test/goalPage.test.ts`.
 */
function ownsPr(pr: PullRequest, issue: Issue, partPrs: ReadonlySet<number>): boolean {
  const ref = `issue:${issue.number}`;
  return partPrs.has(pr.number) || pr.number === issue.linkedPrNumber || branchGoal(pr.branch) === ref;
}

/**
 * The goal a branch name declares, as `issue:<n>` — `issue/12` and `issue/12/signer` both. **One**
 * implementation, read in two directions ({@link ownsPr}, {@link goalOfPr}), to avoid drift.
 */
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

/** How deep a chain of jobs standing in for jobs {@link standsFor} will walk, so a cycle ends as an unresolved origin rather than a spinning loop. */
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

/**
 * Everything one goal's page draws, assembled from the snapshot. Null for a ref the world does not
 * carry. `needs` is passed in rather than rebuilt, so the rail and the page are one reading.
 */
export function buildGoalPage(
  state: AppState,
  ref: string,
  needs: readonly NeedRow[],
  /** The goal's fetched run history, when the page has one — adds runs older than the snapshot's bounded fleet list. */
  history: GoalAgentsPayload | null = null,
): GoalPageView | null {
  const issue = goalIssue(state, ref);
  if (!issue) return null;

  // Every agent this goal has had, from the two lists that each hold half: the snapshot's
  // `agents` has what is happening now, `history` has the whole record as of page open.
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
  // Newest first: the first match for a part is its last run.
  const goalAgents = [...onGoal.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const plan = (state.plans ?? []).find((p) => p.originRef === ref) ?? null;
  const parts = (state.planParts ?? [])
    .filter((p) => plan !== null && p.planId === plan.id)
    .flatMap<GoalPartView>((part) => {
      const group = GROUP_OF[part.status];
      if (!group) return [];
      // Two origins reach one part: the part itself and the pull request it opened.
      const origins = new Set([`${ref}:part:${part.slug}`, ...(part.prNumber === null ? [] : [`pr:${part.prNumber}`])]);
      const on = goalAgents.filter((a) => origins.has(originOf(a) ?? ''));
      // Live first, newest otherwise.
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

  // One lookup for the three environment fields: the row, why obligations are held, and the release.
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
    // Equality, **not** `belongsToGoal`: a check is keyed on the goal itself.
    checks: (state.validationChecks ?? []).filter((c) => c.originRef === ref),
    checkResources: (state.validationResources ?? []).filter((r) => r.originRef === ref),
    environments: reach?.environments ?? [],
    gateHold: reach?.gateHold ?? null,
    gateRelease: reach?.released ?? null,
    watches: (state.goalWatchWindows ?? []).filter((w) => w.goalRef === ref),
    signals: (state.goalWatches ?? []).filter((w) => w.originRef === ref),
    // The **accepted** order only: an unanswered proposal holds nothing.
    sequence: goalSequence(state, issue),
  };
}

/** The order holding this story, from the Feature it hangs off. Null for no parent, unsequenced, or unaccepted alike. */
function goalSequence(state: AppState, issue: Issue): FeatureSequence | null {
  const parent = issue.parent?.number;
  if (parent === undefined) return null;
  const row = (state.featureSequences ?? []).find((s) => s.originRef === `issue:${parent}`);
  return row?.status === 'accepted' ? row : null;
}

/**
 * The furthest environment this goal's whole work has reached, or null when unconfirmed anywhere.
 * **Furthest is last-declared, not best** — the operator's list order is the order work travels in.
 * `partial` and `unknown` are not furthest anything.
 */
export function furthestEnvironment(state: AppState, goalRef: string): string | null {
  const reach = (state.environmentReach ?? []).find((e) => e.goalRef === goalRef);
  const reached = (reach?.environments ?? []).filter((e) => e.status === 'reached');
  return reached.length === 0 ? null : (reached[reached.length - 1]?.environment ?? null);
}

/** The overview's track, folded off the page's own groups rather than off `status` a second time, so row and page cannot disagree. */
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

/** Which of the goal page's sections a track stage points at — a name rather than an element id. */
export type GoalStageAt = 'plan' | 'validation' | 'environments' | 'tail';

/** A tone the console already declares as a `cn-t-*` alias. No stage invents a colour. */
type GoalStageTone = 'green' | 'blue' | 'amber' | 'grey';

/** One stage of the goal's track — a stretch of the pipeline, with the reading that says how far through it the goal is. */
export interface GoalStage {
  at: GoalStageAt;
  /** The stage's own name, as the section it points at calls it. */
  label: string;
  /** How far through, in the words that section uses. Never a verdict of its own. */
  reading: string;
  tone: GoalStageTone;
  /** How far through as a proportion, or **null when there is nothing to measure** — never a synonym for zero. */
  done: number | null;
}

/**
 * The goal's track: the pipeline in four stretches, each a way to the section that owns it.
 * **Every reading here is one the page already draws further down** — no verdict of its own.
 * The environments stage is **absent** when no environment is configured.
 */
export function buildGoalStrip(page: GoalPageView): GoalStage[] {
  const stages: GoalStage[] = [planStage(page), validationStage(page)];
  if (page.environments.length > 0) stages.push(environmentStage(page));
  stages.push(tailStage(page));
  return stages;
}

/** The plan, and how much of it has landed. An unapproved plan reads as its own status rather than "0/0 merged". */
function planStage(page: GoalPageView): GoalStage {
  const base = { at: 'plan', label: 'Plan' } as const;
  if (page.plan === null) return { ...base, reading: 'not drawn', tone: 'grey', done: null };
  if (page.plan.status === 'planning') return { ...base, reading: 'being drawn', tone: 'blue', done: null };
  if (page.plan.status === 'awaiting_approval')
    return { ...base, reading: 'waiting on you', tone: 'amber', done: null };
  if (page.plan.status === 'abandoned') return { ...base, reading: 'abandoned', tone: 'grey', done: null };

  const track = buildGoalTrack(page.parts);
  // A single-PR plan is a first-class funnel outcome with no parts.
  if (track.total === 0) return { ...base, reading: 'one pull request', tone: 'grey', done: null };
  return {
    ...base,
    reading: `${track.merged}/${track.total} parts merged`,
    tone: track.merged === track.total ? 'green' : track.held > 0 ? 'amber' : track.now > 0 ? 'blue' : 'grey',
    done: (track.merged / track.total) * 100,
  };
}

/** The checks, settled against live. Only `failed` earns amber — merely unrun checks are work in progress. */
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
 * How far the landed work has travelled. `unknown` is answered **before** "not shipped": a probe
 * that could not say and work that has not moved are identical once folded, and only one is about
 * deployment. → docs/spec/24-environments.md#the-three-verdicts
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
 * What the watch on one environment says, in three words — or **null where nothing is being
 * watched there**. `unknown` is answered before `clean`, so an unreadable check is never folded
 * into an all-clear.
 */
function watchFold(page: GoalPageView, environment: string): { said: string } | null {
  const window = page.watches.find((w) => w.environment === environment);
  if (window === undefined || window.checks.length === 0) return null;
  const verdicts = window.checks.map((c) => c.reading?.verdict ?? null);
  if (verdicts.includes('regressed')) return { said: 'watch regressed' };
  if (verdicts.some((v) => v !== 'clean')) return { said: 'watch not read' };
  return { said: 'watch clean' };
}

/** What is left once the parts are in: whether anything checked the goal itself, and whether the ticket is shut. */
function tailStage(page: GoalPageView): GoalStage {
  const base = { at: 'tail', label: 'Close-out' } as const;
  const { issue } = page;
  if (issue.state !== 'open') return { ...base, reading: issue.state, tone: 'green', done: 100 };
  if (issue.shortfall) return { ...base, reading: 'fell short', tone: 'amber', done: null };
  if (issue.delivery) return { ...base, reading: 'delivered, ticket open', tone: 'blue', done: null };
  return { ...base, reading: 'not reached', tone: 'grey', done: null };
}

/** A section of the goal page that folds, by name — what `Place` round-trips in `?open=` and `?shut=`. */
export const GOAL_SECTIONS = [
  'ticket',
  'validation',
  'localValidation',
  'signals',
  'sequence',
  'environments',
  'tail',
  'record',
] as const;

export type GoalSection = (typeof GOAL_SECTIONS)[number];

/**
 * Which of the goal page's foldable sections are worth opening *at this point in the goal's life*.
 * Cards with nothing in them yet start **shut**, each carrying its count beside its name.
 *
 * **Default, never state.** `?open=` and `?shut=` are the operator's own word and outrank this in
 * both directions.
 */
export function goalSectionsOpen(page: GoalPageView): Record<GoalSection, boolean> {
  return {
    ticket: !workStarted(page),
    // The arrival is what makes these two relevant; the second arm opens regardless of location.
    validation: (shipped(page) && liveChecks(page) > 0) || page.checks.some((c) => c.state !== 'unrun'),
    // Open when there is a row, shut when there is not.
    localValidation: page.issue.localValidation !== null,
    signals: (shipped(page) && page.signals.length > 0) || page.signals.some((s) => !s.live || s.proposal !== null),
    environments: page.environments.some((e) => e.status !== 'absent'),
    // Shut, always: the folded heading carries the whole point.
    sequence: false,
    tail: tailBegun(page),
    // Fetches its own route on open, and nothing about progress makes it owed.
    record: false,
  };
}

/** Whether anything has happened on this goal yet. A plan is the first thing that does. */
function workStarted(page: GoalPageView): boolean {
  return page.plan !== null || page.openPullRequests.length > 0 || page.agents.length > 0;
}

/**
 * Whether any of this goal's work is anywhere. `partial` **counts** — folding it with `absent`
 * holds the card shut through exactly the deployment an operator is chasing. `unknown` does not.
 * → docs/spec/24-environments.md#the-three-verdicts
 */
function shipped(page: GoalPageView): boolean {
  return page.environments.some((e) => e.status === 'reached' || e.status === 'partial');
}

/** The checks an amendment has not withdrawn — what the card would actually draw. */
function liveChecks(page: GoalPageView): number {
  return page.checks.filter((c) => c.supersededReason === null).length;
}

/** Whether anything in the tail has happened — a verdict on the goal, a write-up, or a shut ticket. */
function tailBegun(page: GoalPageView): boolean {
  const { issue } = page;
  return issue.state !== 'open' || Boolean(issue.delivery) || Boolean(issue.shortfall) || Boolean(issue.retrospective);
}
