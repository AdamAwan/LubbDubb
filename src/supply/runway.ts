import type { EscalationSpan, HumanTask, Issue, IssueRun } from '../types.js';
import { issuePickupStatus, issueWatchGateReason, type IssuePickupContext } from '../dispatcher/issuePickup.js';
import { assayHold } from '../intake/assay.js';
import { liveParts } from '../plans/parts.js';

/**
 * Whether the human is keeping up with the fleet — one reading, two directions.
 *
 * Every other lens in the harness asks about one piece of work. This one asks
 * about the *pipeline*, and it exists because the two ways that pipeline fails
 * are both invisible. A fleet with nothing left to pick up does not error, does
 * not park an agent and records no decision worth reading: it simply goes quiet,
 * which is also what a fleet between goals looks like, and what a fleet whose
 * provider stopped answering looks like. A fleet whose every goal is waiting on a
 * person looks identical from the outside and is the same problem from the other
 * end — the fleet outrunning somebody's ability to *absorb* work rather than to
 * supply it.
 *
 * ## The unit is time, never a count
 *
 * "Fewer than three eligible issues" does not survive a changing `cap`. A
 * three-wide fleet on twenty-minute goals empties a five-deep backlog inside the
 * hour; a one-wide fleet on day-long goals is comfortable with two. So the
 * reading is **how long until nothing is left for a slot to take**:
 *
 * ```
 * supply  = inflight + queued                      (goals)
 * runway  = supply × medianLeadTime ÷ max(1, cap)  (minutes)
 * ```
 *
 * The median comes off {@link IssueRun}'s `startedAt → completedAt`, which is the
 * only span that already contains a goal's whole tail — the CI fixes, the review
 * threads, the assessment and the write-up that follow its pull request. Agent
 * durations would miss all of it and read a goal as twenty minutes of work when
 * it occupies the fleet for three hours.
 *
 * ## The lead time is fleet time, not calendar time
 *
 * That span is wall-clock, and wall-clock is the wrong quantity: it is padded
 * with every hour the goal spent parked on a *person* — a close-out nobody got
 * to, a validation waiting until Tuesday, a profile question asked at six on a
 * Friday — plus the nights and weekends around them. A runway computed from it
 * tells an operator who does nothing for sixty-four hours that the fleet has
 * sixty-four hours of work, when the fleet runs dry long before that *because* he
 * did nothing. The arithmetic is sound and the input is not.
 *
 * So each completed run's calendar span has its **human holds** subtracted:
 * `close_out` and `validate` bench rows, an `ask` that *is* a plan part, the
 * assay's profile gate, a standing delivery, and an escalation nobody answered.
 * What is left is how long the goal occupied the fleet, which is what the drain
 * is a drain of.
 *
 * **The tail stays in.** This subtracts human-wait, never work: a CI fix, a
 * review thread and a write-up are all still inside the span, which is why agent
 * durations are still not the substitute the paragraph above rejects.
 *
 * **The holds are unioned per goal before they are subtracted.** They overlap
 * routinely — a delivery hold and the close-out it caused cover the same
 * afternoon — and adding them up would over-subtract, which is this same bug
 * pointed the other way.
 *
 * **What is not subtracted, and knowingly.** A plan awaiting approval is a hold
 * with no start time to read: `plans` stamps `createdAt`/`updatedAt` and nothing
 * for entering `awaiting_approval`, and by the time a run is complete its plan is
 * `active` or `complete`, so the span is not recoverable from a finished goal at
 * all. Nor are non-working hours, which would need a timezone and a schedule the
 * harness does not have. Both leave a residual, and the residual is padding — the
 * reading still errs long, never short.
 *
 * ## Why the drain is capacity and not the observed start rate
 *
 * The obvious estimator is how fast goals have actually been *starting*, and it
 * is the one estimator that cannot work: a starved fleet starts nothing, so the
 * observed rate falls towards zero, so the runway computed from it rises towards
 * infinity. The warning would suppress itself exactly when it is due. Capacity
 * over median lead time is self-consistent — it says how fast the fleet drains
 * when it is saturated, which is the question being asked.
 *
 * ## Median, never mean
 *
 * {@link BurnPolicy}'s reason exactly: one nine-day goal in the history would drag
 * a mean upward until a fleet with a fortnight of backlog reported a week of
 * runway. The spread between goals is real work rather than noise, and the median
 * is the reading that survives it.
 *
 * @see docs/spec/25-supply.md
 */

/**
 * What the pipeline is doing. Five, and deliberately not six.
 *
 * The temptation is a sixth for the fleet that is idle because everything is
 * parked on a person — "silted". It is not a state: it is `starved` with the
 * sentence rearranged, because the *fleet* is in precisely the same condition and
 * only the reason differs. A state whose whole content is which clause leads the
 * detail would double the machine to say something the wording already says.
 *
 * `unknown` is not folded into anything, on {@link GoalEnvironmentReach}'s
 * grounds: a deployment two days old and a deployment that has run dry present
 * identically to anything that rounds "cannot say" down to "nothing left".
 */
export type SupplyState = 'healthy' | 'thin' | 'dry' | 'starved' | 'unknown';

/** When a thinning queue is worth an operator's attention, and when it has recovered. */
export interface RunwayPolicy {
  /**
   * Master switch. Off files nothing — and still settles rows already standing,
   * so turning it off drains the bench rather than stranding a row nothing left
   * running will ever close.
   */
  enabled: boolean;
  /** Hours of runway below which a row is filed. */
  warnHours: number;
  /**
   * Hours of runway a standing row must be *back above* before it settles.
   *
   * The second threshold is the whole of the anti-nag design, not a refinement.
   * With one number the row files at 59 minutes, settles at 61 when a goal is
   * watched, files again at 59 when the next one starts, and the operator gets a
   * banner every few minutes for a queue that is hovering. It must be above
   * {@link warnHours}; `validateRunwayPolicy` refuses anything else.
   */
  clearHours: number;
  /**
   * Completed runs needed before the median lead time is trusted at all.
   *
   * Below it the reading is `unknown` rather than guessed at — but only on the
   * arms that need a duration. `starved` and `dry` are observations about right
   * now and are reported on a deployment with no history whatever.
   */
  minimumRuns: number;
}

/**
 * On, at an hour, clearing at three, over five completed goals.
 *
 * An hour is roughly one goal's work on a three-wide fleet at this repo's own
 * median, which is the point: it is late enough that a fleet dipping between
 * goals never trips it, and early enough that there is still time to triage
 * before a slot goes empty.
 */
export const DEFAULT_RUNWAY: RunwayPolicy = {
  enabled: true,
  warnHours: 1,
  clearHours: 3,
  minimumRuns: 5,
};

/**
 * Refuse a policy that cannot do what it says, at load, naming the key.
 *
 * `clearHours` at or below `warnHours` is the one that matters: it does not fail,
 * it flaps, and a notification channel that cries wolf every four minutes is
 * worse than no channel at all.
 */
export function validateRunwayPolicy(policy: RunwayPolicy): void {
  if (typeof policy.warnHours !== 'number' || !(policy.warnHours > 0) || !Number.isFinite(policy.warnHours))
    throw new Error(
      `Refusing to start: runway.warnHours is ${JSON.stringify(policy.warnHours)}, and must be a number of hours ` +
        `above 0 — the runway below which the queue is worth an operator's attention.`,
    );
  if (typeof policy.clearHours !== 'number' || !(policy.clearHours > policy.warnHours))
    throw new Error(
      `Refusing to start: runway.clearHours is ${JSON.stringify(policy.clearHours)}, and must be a number of hours ` +
        `above runway.warnHours (${policy.warnHours}) — at or below it the notice flaps between filed and settled ` +
        `every time one goal finishes.`,
    );
  if (!Number.isInteger(policy.minimumRuns) || policy.minimumRuns < 1)
    throw new Error(
      `Refusing to start: runway.minimumRuns is ${JSON.stringify(policy.minimumRuns)}, and must be a whole number ` +
        `of completed goals (1 or more) before their median lead time is trusted.`,
    );
}

/** Supply the fleet cannot reach until a person answers something, and what answering would release. */
interface LatentSupply {
  /** Plans written and awaiting an approval. */
  plans: number;
  /** Goals held by the assay's profile question (issue #342). */
  profiles: number;
  /** Goals whose attempt cap is spent, parked on a person. */
  escalated: number;
  /** Live parts the standing plans would release between them. */
  parts: number;
}

/** What the pipeline looks like right now, and why. Derived, never stored. */
export interface RunwayReading {
  state: SupplyState;
  /**
   * Minutes until the fleet has nothing to take, or null when no duration is
   * honest — an empty queue (there is no runway to state, only idle slots) or too
   * little history for a median.
   */
  runwayMinutes: number | null;
  /** Goals being worked: an agent on them, a pull request open, or in the plan funnel. */
  inflight: number;
  /** Unstarted goals the fleet may take — eligible, capacity-blocked, or cooling down. */
  queued: number;
  /** Open issues nobody has opted in. One watch write each; a Feature's is a cascade. */
  reservoir: number;
  /** How many of the reservoir are containers, whose watch reaches every descendant. */
  reservoirContainers: number;
  /** Goals parked on a person — delivered, retained, escalated, or held at intake. */
  held: number;
  /** Supply a decision would release, and what it would release. */
  latent: LatentSupply;
  /** Obligations that return nothing to the fleet. Named when they explain a starved one; never a threshold. */
  debt: number;
  /**
   * The median goal lead time in minutes — **fleet time**, with the spans a
   * person was the next mover taken out. Null below `minimumRuns`.
   */
  medianLeadMinutes: number | null;
  /**
   * The median goal's human wait, in minutes: what was taken out to get the
   * figure above, over the same runs.
   *
   * Reported rather than merely subtracted because the two together are the
   * answer to the objection that made this a duration worth trusting — "you say
   * sixty-four hours and the fleet is dry by Tuesday" is answered by naming the
   * calendar span *and* the part of it nobody was working. Zero is a real
   * reading: no evidenced hold touched any of the runs in the median.
   */
  medianHeldMinutes: number | null;
  /** How many completed goals that median was taken over. */
  completedRuns: number;
  /** Slots doing nothing this instant. Zero while paused, which is not idleness. */
  idleSlots: number;
  /** The row's one line, and what sits under it. Written here so the desk and the card cannot word it differently. */
  headline: string;
  detail: string;
}

/** Everything the reading is taken from. */
export interface RunwayInput {
  policy: RunwayPolicy;
  /**
   * Every open issue the harness can see, and the context its pickup verdict is
   * taken in. The verdict is taken **here**, through `issuePickupStatus`, rather
   * than passed in already computed: the buckets below are a re-reading of that
   * one function's answer, and a caller free to pair an issue with somebody
   * else's verdict is a caller free to disagree with the gate silently.
   */
  issues: readonly Issue[];
  /**
   * The gate's own context — and the *only* copy of the plans, the parts and the
   * assay verdicts. They are read back out of it below rather than passed
   * alongside, for the reason above one level up: a caller free to hand the lens
   * a different plan list from the one the verdicts were taken in is a caller
   * free to report a goal as queued and as awaiting approval in one breath.
   */
  pickup: IssuePickupContext;
  /** Every run the floor holds — the completed ones are the median. */
  runs: readonly IssueRun[];
  /**
   * **Every** bench row the store holds, settled ones included — one list read
   * two ways.
   *
   * The open ones are the debt count. The settled ones are how long each goal in
   * the history spent waiting on a person, which is what the median lead time
   * has taken out of it. `supply` rows count for neither: this reading must not
   * describe itself.
   *
   * One list rather than an open one beside a closed one, on the rule above: two
   * lists of the same table, either a subset of the other, is a caller free to
   * report a debt that the history beside it does not contain.
   */
  humanTasks: readonly HumanTask[];
  /**
   * When each escalation stood, and the two context keys a goal can be reached
   * through — {@link EscalationSpan}.
   *
   * The projection rather than the rows for the reason `listEscalationSpans`
   * states, and *raw* rather than resolved for the reason the pickup context is:
   * deciding which escalation stopped which goal is this lens's judgement, and a
   * caller that made it would be a caller free to attribute an afternoon of
   * waiting to somebody else's goal.
   */
  escalations: readonly EscalationSpan[];
  /** The fleet's width, read by reference from `RuntimeControl` exactly as the pulse reads it. */
  cap: number;
  /**
   * Whether a `supply` row is standing. The hysteresis is the whole of the
   * anti-nag design and it needs no stored state beyond this: entering the warn
   * band takes `warnHours`, leaving it takes `clearHours`.
   */
  standing: boolean;
}

/** Statuses that mean the fleet is on it. */
const INFLIGHT = new Set(['active', 'has_pr', 'planning']);
/**
 * Statuses that mean unstarted work the fleet may take.
 *
 * `blocked` is in here and it is the healthiest reading on the card: it means
 * more work than slots, which is the condition this whole module exists to keep
 * a deployment in. `cooldown` is supply that is coming back — a naive count that
 * dropped it would report a fleet as starved on the one pulse after a retry.
 */
const QUEUED = new Set(['eligible', 'blocked', 'cooldown']);
/**
 * Statuses that mean a person is the next mover.
 *
 * `assay` is **not** in here and cannot be: the status covers two opposite
 * situations — an issue the fleet is about to assay, which is ordinary unstarted
 * supply, and one an assayer refused or priced and left standing, which is parked
 * on a person. They are separated below by asking `assayHold`, the same function
 * the gate itself asks. Read as held, every freshly tagged issue on the
 * deployment would count as work nobody can do and the fleet would look starved
 * the moment somebody filled the queue.
 */
const HELD = new Set(['escalated', 'delivered', 'retained']);

/**
 * Take the reading.
 *
 * Pure over its input, so every state below is reachable in a test without a
 * store, a clock or a fleet — which matters more here than usual, because the
 * states that need proving are the ones a running deployment reaches once a
 * month.
 */
export function readRunway(input: RunwayInput): RunwayReading {
  let inflight = 0;
  let queued = 0;
  let reservoir = 0;
  let reservoirContainers = 0;
  let held = 0;
  let escalated = 0;

  const assays = input.pickup.assays ?? [];
  const plans = input.pickup.plans ?? [];
  const planParts = input.pickup.planParts ?? [];

  for (const issue of input.issues) {
    const { status } = issuePickupStatus(issue, input.pickup);
    if (INFLIGHT.has(status)) inflight += 1;
    else if (QUEUED.has(status)) queued += 1;
    else if (status === 'assay') {
      // The split the status alone cannot make. A null hold is the pending arm —
      // the fleet has not got to it yet, which is what a queue *is*.
      const hold = assayHold(assays.find((a) => a.originRef === `issue:${issue.number}`) ?? null, issue, {
        signals: input.pickup.assaySignals ?? [],
      });
      if (hold === null) queued += 1;
      else held += 1;
    } else if (HELD.has(status)) {
      held += 1;
      if (status === 'escalated') escalated += 1;
    } else if (status === 'unwatched') reservoir += 1;
    else if (status === 'container' && issueWatchGateReason(issue, input.pickup.policy) !== null) {
      // Counted as a way in rather than as work: a container is never dispatched
      // at, so it is worth nothing to the fleet on its own — but one watch write
      // on it reaches every descendant, and those descendants are already in the
      // reservoir above under their own numbers. Adding its children here would
      // count the same stories twice.
      reservoirContainers += 1;
    }
  }

  const { lead: medianLeadMinutes, held: medianHeldMinutes } = medianLead(
    input.runs,
    input.policy.minimumRuns,
    humanHolds(input),
  );
  const completedRuns = input.runs.filter((r) => r.completedAt !== null).length;
  const supply = inflight + queued;
  const cap = Math.max(1, input.cap);
  // Off the pulse's own headroom, never `cap - inflight`. They are different
  // questions and only one of them is about slots: a goal with an open pull
  // request is in flight and holds no agent, so counting goals here would report
  // a fully-staffed fleet as having spare capacity. Headroom is what the
  // dispatcher itself cut against this pulse.
  const idleSlots = input.pickup.paused ? 0 : Math.max(0, input.pickup.headroom);
  const runwayMinutes =
    queued === 0 || medianLeadMinutes === null ? null : Math.round((supply * medianLeadMinutes) / cap);

  const latent: LatentSupply = {
    plans: plans.filter((p) => p.status === 'awaiting_approval').length,
    // The one hold the harness raises with no row of its own: an assay that
    // proposed a profile and has not been answered stops the goal before there is
    // a plan to hold anything. Same predicate the queue rail reads it by.
    profiles: assays.filter((a) => a.proposedProfile !== null && a.profileAnsweredAt === null).length,
    escalated,
    parts: plans
      .filter((p) => p.status === 'awaiting_approval')
      .reduce((n, p) => n + liveParts(planParts.filter((part) => part.planId === p.id)).length, 0),
  };
  const debt = input.humanTasks.filter((t) => t.status === 'open' && t.kind !== 'supply').length;

  const state = resolveState({
    policy: input.policy,
    paused: input.pickup.paused,
    queued,
    idleSlots,
    runwayMinutes,
    medianLeadMinutes,
    standing: input.standing,
  });

  const reading: Omit<RunwayReading, 'headline' | 'detail'> = {
    state,
    runwayMinutes,
    inflight,
    queued,
    reservoir,
    reservoirContainers,
    held,
    latent,
    debt,
    medianLeadMinutes,
    medianHeldMinutes,
    completedRuns,
    idleSlots,
  };
  return { ...reading, ...say(reading, cap) };
}

/**
 * Which state, in the order the conditions actually settle each other.
 *
 * **`starved` before `dry` before the duration arms**, and the ordering is
 * load-bearing rather than a preference. Any fleet with a free slot and an empty
 * queue satisfies both of the first two, and reporting the weaker one describes a
 * fleet that is *about to* go idle while it already has. Both are observations
 * about this instant and neither needs a median, which is why `unknown` sits
 * below them and not above: a deployment two days old with two empty slots is
 * genuinely starved, and withholding that until it has five completed goals would
 * silence the warning for exactly the week it is most useful.
 */
function resolveState(input: {
  policy: RunwayPolicy;
  paused: boolean;
  queued: number;
  idleSlots: number;
  runwayMinutes: number | null;
  medianLeadMinutes: number | null;
  standing: boolean;
}): SupplyState {
  // A paused fleet is idle because somebody stopped it. Nothing here is news to
  // the person who pressed the button, and `idleSlots` is already zero for them.
  if (!input.paused && input.queued === 0 && input.idleSlots > 0) return 'starved';
  if (input.queued === 0) return 'dry';
  if (input.runwayMinutes === null || input.medianLeadMinutes === null) return 'unknown';
  // The hysteresis: entering the band costs `warnHours`, leaving it costs
  // `clearHours`. A standing row therefore survives a partial recovery instead of
  // settling and re-filing on the next goal that finishes.
  const threshold = (input.standing ? input.policy.clearHours : input.policy.warnHours) * 60;
  return input.runwayMinutes < threshold ? 'thin' : 'healthy';
}

/**
 * The median completed run, in minutes of **fleet time** and of the human wait
 * taken out of it — both null below `minimum` readable runs.
 *
 * Two medians over one surviving set rather than two filters: they are quoted
 * side by side in the sentence, and taken separately they would eventually be
 * taken over different goals.
 *
 * A run whose whole calendar span is covered by holds is **dropped**, exactly as
 * a run with an unreadable span is. Zero minutes of fleet time is not evidence
 * about how long the fleet works — it is evidence that the hold rows are coarser
 * than the run — and admitting it would drag the median towards zero and leave a
 * deployment permanently `thin` over a queue that is fine.
 */
function medianLead(
  runs: readonly IssueRun[],
  minimum: number,
  holds: Map<string, Hold[]>,
): { lead: number | null; held: number | null } {
  const pairs = runs
    .filter((r) => r.completedAt !== null)
    .map((r) => {
      const from = Date.parse(r.startedAt);
      const to = Date.parse(r.completedAt as string);
      const held = heldWithin(holds.get(r.originRef) ?? [], from, to);
      return { work: to - from - held, held };
    })
    // A clock that went backwards between two pulses, or a row written by an
    // older build, would otherwise put a negative span in the middle of the sort.
    .filter((p) => Number.isFinite(p.work) && p.work > 0);
  if (pairs.length < minimum) return { lead: null, held: null };
  return { lead: medianMinutes(pairs.map((p) => p.work)), held: medianMinutes(pairs.map((p) => p.held)) };
}

/** The median of a non-empty list of milliseconds, in whole minutes. */
function medianMinutes(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ms =
    sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(ms / 60_000);
}

/**
 * A span in which the fleet had stopped on one goal and a person was the next
 * mover. `to` is null while it is still standing.
 */
interface Hold {
  from: number;
  to: number | null;
}

/**
 * The goal a ref belongs to, as `issue:<n>` — or null for a ref that is not about
 * one.
 *
 * A part's ref (`issue:12:part:api`) folds onto its goal deliberately: a person
 * holding one part of a decomposition is holding the goal's progress, and the
 * lead time being measured is the goal's.
 */
function goalOf(ref: string | null): string | null {
  const m = ref === null ? null : /^issue:(\d+)(?::|$)/.exec(ref);
  return m ? `issue:${m[1] as string}` : null;
}

/**
 * Whether a bench row means the fleet has stopped, which is a narrower question
 * than whether somebody owes something.
 *
 * - `close_out` and `validate` — yes. The harness has done what it can and filed
 *   the row saying so; nothing moves until a person acts.
 * - `ask` — **only when it is a plan part.** {@link HumanTask} states the rule
 *   this reads: a standalone ask blocks nothing, because the agent that filed it
 *   "gets on with, or concludes, what it can". Only `partId` makes one a
 *   scheduling node the reconciler holds work behind.
 * - `burn` — no, and this is the one worth stating. A burn notice kills nothing
 *   (`src/spendBurn.ts`): the expensive agent carries straight on while the row
 *   stands, so the fleet is working through every minute of it.
 * - `supply` — no. This reading must not describe itself, the rule the debt count
 *   already follows.
 */
function benchRowHolds(t: HumanTask): boolean {
  if (t.kind === 'close_out' || t.kind === 'validate') return true;
  return t.kind === 'ask' && t.partId !== null;
}

/**
 * Every human hold the input can evidence, filed under the goal it stopped.
 *
 * Taken here, off the raw rows, rather than handed in already classified: which
 * kinds of row mean "the fleet stopped" is the judgement the median is made of,
 * and a caller free to make it differently is a caller free to disagree with the
 * lens about its own reading — {@link RunwayInput}'s rule, one level down.
 */
function humanHolds(input: RunwayInput): Map<string, Hold[]> {
  const held = new Map<string, Hold[]>();
  const add = (ref: string | null, from: string, to: string | null): void => {
    const goal = goalOf(ref);
    const start = Date.parse(from);
    if (goal === null || !Number.isFinite(start)) return;
    const end = to === null ? NaN : Date.parse(to);
    const list = held.get(goal) ?? [];
    // A row whose end will not parse is read as still standing rather than
    // dropped: an unreadable timestamp is a hold of unknown length, and the clamp
    // below is what stops that meaning more than the run it sits in.
    list.push({ from: start, to: Number.isFinite(end) ? end : null });
    held.set(goal, list);
  };

  for (const t of input.humanTasks) if (benchRowHolds(t)) add(t.originRef, t.createdAt, t.resolvedAt);
  // The assay's profile gate — the one hold the harness raises with no row of its
  // own, and the only one whose predicate lives in another module. Asked through
  // `assayHold`, the same pure function the pickup gate and the queue bucket ask,
  // because two matchers for one claim is how the bucket ends up calling a goal
  // unheld in the same reading that erases its run as held.
  const issuesByRef = new Map(input.issues.map((i) => [`issue:${i.number}`, i]));
  for (const a of input.pickup.assays ?? []) {
    // **The span is closed or it is nothing.** An unanswered proposal has no end,
    // and read to the end of the run it subtracts every minute a goal that
    // demonstrably *shipped* spent shipping — the completion being the evidence it
    // was not held. Only `decided_at → profile_answered_at` is a hold the input
    // evidences; the open-ended treatment is spec'd for the standing delivery
    // below and for nothing else.
    if (a.profileAnsweredAt === null) continue;
    const issue = issuesByRef.get(a.originRef);
    if (!issue) continue;
    // Asked as of the hold's *start*, which is the only moment there is a hold to
    // ask about: with the answer in, the gate arm is released by construction and
    // `assayHold` would say so about every closed span alike. What it still rules
    // on is the release the re-implementation missed — a ticket rewritten since
    // the assay was never held by it.
    if (assayHold({ ...a, profileAnsweredAt: null }, issue, { signals: input.pickup.assaySignals ?? [] }) === null)
      continue;
    add(a.originRef, a.decidedAt, a.profileAnsweredAt);
  }
  // A standing delivery: the harness believes it is finished and is waiting to be
  // told otherwise. It has no end — it stops standing when the world moves, which
  // is not an instant anything records — so it runs to the end of the run, which
  // is where the clamp puts it.
  for (const d of input.pickup.deliveries ?? []) add(d.originRef, d.decidedAt, null);
  const byPr = prGoals(input.runs);
  for (const e of input.escalations) {
    // Answered, or open right now. A *dismissed* escalation was never answered
    // and `dismissEscalation` stamps no time, so when its hold ended is recorded
    // nowhere — counting it to the end of the run would subtract an afternoon
    // nobody waited.
    if (e.answeredAt === null && !e.open) continue;
    // Two handles and neither is an origin column. `context.originRef` is what the
    // goal-work arms carry; `prNumber` is all the merge and reply arms have, and
    // the run's own `linkedPrNumber` is what turns one into a goal.
    const ref = goalOf(e.originRef) ?? (e.prNumber === null ? null : (byPr.get(e.prNumber) ?? null));
    if (ref !== null) add(ref, e.createdAt, e.answeredAt);
  }
  return held;
}

/** Pull request number → the goal it resolved, off the runs the lens already holds. */
function prGoals(runs: readonly IssueRun[]): Map<number, string> {
  const byPr = new Map<number, string>();
  for (const r of runs) if (r.linkedPrNumber !== null) byPr.set(r.linkedPrNumber, r.originRef);
  return byPr;
}

/**
 * How much of `[from, to]` a person was the next mover for — the **union** of the
 * holds, never their sum.
 *
 * Clamped to the run's own span first, so a close-out still standing three weeks
 * after a goal finished subtracts the minutes inside the run and not the weeks
 * after it.
 */
function heldWithin(holds: readonly Hold[], from: number, to: number): number {
  const spans = holds
    .map((h) => ({ from: Math.max(h.from, from), to: Math.min(h.to ?? to, to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  let total = 0;
  let cursor = -Infinity;
  for (const s of spans) {
    const start = Math.max(s.from, cursor);
    if (s.to > start) {
      total += s.to - start;
      cursor = s.to;
    }
  }
  return total;
}

/** `50 minutes`, `1h 20m` — a duration a sentence can carry. */
function humanMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** `6 issues`, `1 issue` — the reservoir clause, or null when there is nothing to point at. */
function reservoirClause(reading: Omit<RunwayReading, 'headline' | 'detail'>): string | null {
  if (reading.reservoir === 0) return null;
  const base = `${reading.reservoir} open issue${reading.reservoir === 1 ? '' : 's'} nobody has watched`;
  return reading.reservoirContainers === 0
    ? base
    : `${base}, under ${reading.reservoirContainers} unwatched container${reading.reservoirContainers === 1 ? '' : 's'} whose watch would cascade`;
}

/**
 * The sentence, decided beside the numbers it is about.
 *
 * Written here rather than in the desk or the card because there are three
 * surfaces for one reading — the bench row, its notification, and the band under
 * Fleet — and a sentence assembled separately on each is a sentence that
 * eventually disagrees with the figures beside it.
 *
 * **Latent supply leads whenever there is any**, on every arm that means the
 * fleet has stopped. That is the whole of "silted": telling an operator with
 * three plans awaiting approval to go and find more work would be wrong twice
 * over — there is work, and they are the reason it is not moving.
 *
 * **The headline is a function of the state alone, and every figure lives in the
 * detail.** It is the bench row's title, which is both `recordHumanTask`'s dedup
 * key and the identity the notification chain diffs on — so a headline carrying
 * the runway settles and re-files the row, with a fresh notification, every time
 * the queue moves by one issue. That is the flap `validateRunwayPolicy` refuses a
 * `clearHours` at or below `warnHours` to prevent, reintroduced through the
 * wording. With the title constant per state, a standing row is *refreshed* in
 * place and its detail's figures come current without its id moving, which is
 * what makes "a state change replaces it, and nothing else does" literally true.
 * The latent/non-latent split is a second title per state and not a figure: it is
 * a different thing to say, not the same thing with a different number in it.
 */
function say(reading: Omit<RunwayReading, 'headline' | 'detail'>, cap: number): { headline: string; detail: string } {
  const latent = latentClause(reading.latent);
  const reservoir = reservoirClause(reading);
  const debt =
    reading.debt === 0 ? null : `${reading.debt} other row${reading.debt === 1 ? '' : 's'} on the bench are open.`;

  if (reading.state === 'starved') {
    const headline = latent ? 'The fleet is waiting on you, not on work' : 'Slots are idle with nothing to take';
    return {
      headline,
      detail: [
        `Nothing is eligible for pickup and ${reading.idleSlots} of ${cap} slot${cap === 1 ? '' : 's'} ` +
          `${reading.idleSlots === 1 ? 'is' : 'are'} empty.`,
        latent,
        reservoir === null ? null : `${capitalise(reservoir)}.`,
        debt,
      ]
        .filter((s): s is string => s !== null)
        .join(' '),
    };
  }

  if (reading.state === 'dry') {
    return {
      headline: latent ? 'The fleet is waiting on you, not on work' : 'Nothing is queued behind the fleet',
      detail: [
        `${reading.inflight} goal${reading.inflight === 1 ? ' is' : 's are'} in flight and nothing is waiting behind ` +
          `them — the next one to finish leaves a slot with nothing to take it.`,
        latent,
        reservoir === null ? null : `${capitalise(reservoir)}.`,
      ]
        .filter((s): s is string => s !== null)
        .join(' '),
    };
  }

  if (reading.state === 'thin' && reading.runwayMinutes !== null) {
    return {
      headline: 'The queue is thinning',
      detail: [
        `${reading.inflight} in flight, ${reading.queued} waiting. At ${cap} slot${cap === 1 ? '' : 's'} and a ` +
          `${humanMinutes(reading.medianLeadMinutes ?? 0)} median goal of fleet time, that is ` +
          `${humanMinutes(reading.runwayMinutes)} before the fleet runs out.`,
        heldClause(reading),
        reservoir === null ? null : `${capitalise(reservoir)}.`,
        latent,
      ]
        .filter((s): s is string => s !== null)
        .join(' '),
    };
  }

  // `healthy` and `unknown` file nothing, so these two exist to be drawn on the
  // card rather than read off a row — and `unknown` says which reading it is
  // missing, because "—" on a gauge is indistinguishable from a gauge that broke.
  if (reading.state === 'unknown') {
    return {
      headline: 'Not enough history for a runway yet',
      detail:
        `${reading.completedRuns} goal${reading.completedRuns === 1 ? ' has' : 's have'} completed; a median ` +
        `lead time is taken over more. ${reading.inflight} in flight, ${reading.queued} waiting.`,
    };
  }
  return {
    headline: 'Healthy',
    detail:
      `${reading.inflight} in flight, ${reading.queued} waiting.` +
      (reading.runwayMinutes === null ? '' : ` About ${humanMinutes(reading.runwayMinutes)} of work queued.`),
  };
}

/**
 * What "fleet time" cost the figure beside it, or null when no evidenced hold
 * touched the history.
 *
 * The clause exists because the number moved: an operator who knew this reading
 * as a calendar span and now sees a third of it must be told what left, in the
 * same sentence, or the fix reads as the gauge having broken.
 */
function heldClause(reading: Omit<RunwayReading, 'headline' | 'detail'>): string | null {
  const held = reading.medianHeldMinutes ?? 0;
  const lead = reading.medianLeadMinutes ?? 0;
  if (held <= 0) return null;
  return (
    `That goal's median calendar span is ${humanMinutes(lead + held)} — the ${humanMinutes(held)} of it ` +
    `spent waiting on you is not the fleet's time and is not counted.`
  );
}

/** What answering the standing decisions would put back in the fleet, or null when nothing is standing. */
function latentClause(latent: LatentSupply): string | null {
  const parts: string[] = [];
  if (latent.plans > 0) parts.push(`${latent.plans} plan${latent.plans === 1 ? '' : 's'} awaiting approval`);
  if (latent.profiles > 0) parts.push(`${latent.profiles} profile gate${latent.profiles === 1 ? '' : 's'}`);
  if (latent.escalated > 0) parts.push(`${latent.escalated} escalated goal${latent.escalated === 1 ? '' : 's'}`);
  if (parts.length === 0) return null;
  const answers = latent.plans + latent.profiles + latent.escalated;
  const releases =
    latent.parts > 0
      ? ` — answering them puts ${latent.parts} part${latent.parts === 1 ? '' : 's'} back in the fleet`
      : ' — answering them is what releases the next work';
  return `${capitalise(list(parts))} ${answers === 1 ? 'is' : 'are'} standing${releases}.`;
}

/** `a, b and c` — the one place a clause list is joined, so three surfaces cannot punctuate it differently. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What a pass decided, as data — so the decisions are testable without a store,
 * on {@link burnPass}'s pattern.
 */
type RunwayStep =
  | { kind: 'file'; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string };

/**
 * What this pulse owes: at most one open `supply` row, wearing the current
 * state's wording.
 *
 * **Exactly one row, and a state change replaces it.** `recordHumanTask` dedups
 * on the title, so a row whose wording changed is a *new* row rather than a
 * refreshed one — which is what the notification chain needs (a standing row is
 * already in the previous snapshot and cannot re-announce, so `thin → dry` gets
 * one further banner and nothing else does) and also what makes settling the old
 * one obligatory. Leaving both would put two rows describing one fleet on the
 * bench.
 *
 * A row an operator has already answered is not re-filed: `recordHumanTask` would
 * refresh its detail rather than reopen it, so the settled ones are what the
 * `answered` check below reads.
 */
export function runwayPass(input: {
  reading: RunwayReading;
  /** Every `supply` row the store holds, settled ones included. */
  existing: readonly HumanTask[];
  enabled: boolean;
}): RunwayStep[] {
  const steps: RunwayStep[] = [];
  const wanted = FILES.has(input.reading.state) && input.enabled ? input.reading.headline : null;
  const open = input.existing.filter((t) => t.status === 'open');

  // The settle arm runs whether or not the watch is on, and before the file arm
  // so a state change reads as one replacement rather than two rows in a race.
  for (const row of open) {
    if (row.title === wanted) continue;
    steps.push({
      kind: 'settle',
      taskId: row.id,
      status: 'done',
      resolution:
        wanted === null
          ? `the queue recovered — ${input.reading.detail}`
          : `superseded: ${input.reading.headline.toLowerCase()}`,
    });
  }
  if (wanted === null) return steps;
  // Standing already, under this exact wording: `recordHumanTask` would refresh
  // the figures, which is what keeps a standing row current, so file it again.
  // Answered already, under this wording: leave it alone. The operator has been
  // told, and being told twice is the failure this module is most able to cause.
  if (input.existing.some((t) => t.status !== 'open' && t.title === wanted)) return steps;
  steps.push({ kind: 'file', title: wanted, detail: input.reading.detail });
  return steps;
}

/** The states worth a person's attention. `healthy` is the goal and `unknown` has nothing to say yet. */
const FILES = new Set<SupplyState>(['thin', 'dry', 'starved']);
