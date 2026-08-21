import type { HumanTask, Issue, IssueRun } from '../types.js';
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
  /** The median goal lead time in minutes, or null below `minimumRuns`. */
  medianLeadMinutes: number | null;
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
  /** Open bench rows, for the debt count. `supply` rows are excluded — this must not describe itself. */
  humanTasks: readonly HumanTask[];
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

  const medianLeadMinutes = medianLead(input.runs, input.policy.minimumRuns);
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

/** The median completed lead time in minutes, or null below `minimum` completed runs. */
function medianLead(runs: readonly IssueRun[], minimum: number): number | null {
  const spans = runs
    .filter((r) => r.completedAt !== null)
    .map((r) => Date.parse(r.completedAt as string) - Date.parse(r.startedAt))
    // A clock that went backwards between two pulses, or a row written by an
    // older build, would otherwise put a negative span in the middle of the sort.
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);
  if (spans.length < minimum) return null;
  const mid = Math.floor(spans.length / 2);
  const ms =
    spans.length % 2 === 1 ? (spans[mid] as number) : ((spans[mid - 1] as number) + (spans[mid] as number)) / 2;
  return Math.round(ms / 60_000);
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
 */
function say(reading: Omit<RunwayReading, 'headline' | 'detail'>, cap: number): { headline: string; detail: string } {
  const latent = latentClause(reading.latent);
  const reservoir = reservoirClause(reading);
  const debt =
    reading.debt === 0 ? null : `${reading.debt} other row${reading.debt === 1 ? '' : 's'} on the bench are open.`;

  if (reading.state === 'starved') {
    const headline = latent
      ? 'The fleet is waiting on you, not on work'
      : `${reading.idleSlots} of ${cap} slot${cap === 1 ? '' : 's'} are idle`;
    return {
      headline,
      detail: [
        `Nothing is eligible for pickup and ${reading.idleSlots} slot${reading.idleSlots === 1 ? ' is' : 's are'} empty.`,
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
      headline: `About ${humanMinutes(reading.runwayMinutes)} of work queued`,
      detail: [
        `${reading.inflight} in flight, ${reading.queued} waiting. At ${cap} slot${cap === 1 ? '' : 's'} and a ` +
          `${humanMinutes(reading.medianLeadMinutes ?? 0)} median goal, that is ` +
          `${humanMinutes(reading.runwayMinutes)} before the fleet runs out.`,
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
    headline:
      reading.runwayMinutes === null ? 'Healthy' : `About ${humanMinutes(reading.runwayMinutes)} of work queued`,
    detail: `${reading.inflight} in flight, ${reading.queued} waiting.`,
  };
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
