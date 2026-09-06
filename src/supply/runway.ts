import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { EscalationSpan, HumanTask, Issue, IssueRun } from '../types.js';
import { issuePickupStatus, issueWatchGateReason, type IssuePickupContext } from '../dispatcher/issuePickup.js';
import { appraisalHold } from '../intake/appraisal.js';
import { liveParts } from '../plans/parts.js';

/**
 * Whether the human is keeping up with the fleet — one reading about the
 * *pipeline*, which fails silently in both directions: an empty queue and a
 * fleet whose every goal waits on a person both simply go quiet.
 * **The unit is time, never a count**, since a count does not survive a
 * changing `cap`:
 *
 * ```
 * supply  = inflight + queued                      (goals)
 * runway  = supply × medianLeadTime ÷ max(1, cap)  (minutes)
 * ```
 *
 * The median comes off {@link IssueRun}'s `startedAt → completedAt` with its
 * **human holds** subtracted (unioned per goal, since they overlap routinely),
 * so it is fleet time, not calendar time. A plan awaiting approval and
 * non-working hours are knowingly not subtracted — both err long, never
 * short. The drain is **capacity**, never the observed start rate: a starved
 * fleet starts nothing, so a rate-based runway would rise toward infinity
 * exactly when the warning is due. **Median, never mean.**
 * @see docs/spec/25-supply.md
 */

/**
 * What the pipeline is doing. Five, deliberately not six: a fleet idle because
 * everything is parked on a person is `starved` with the sentence rearranged,
 * not a sixth state. `unknown` is not folded into anything.
 */
export type SupplyState = 'healthy' | 'thin' | 'dry' | 'starved' | 'unknown';

/** When a thinning queue is worth an operator's attention, and when it has recovered. */
export interface RunwayPolicy {
  /** Master switch. Off files nothing, but still settles rows already standing, so turning it off drains the bench rather than stranding a row. */
  enabled: boolean;
  /** Hours of runway below which a row is filed. */
  warnHours: number;
  /** Hours of runway a standing row must be *back above* before it settles — the anti-nag design. Must be above {@link warnHours}; `validateRunwayPolicy` refuses anything else. */
  clearHours: number;
  /** Completed runs needed before the median lead time is trusted. Below it the reading is `unknown`, but only on arms needing a duration — `starved` and `dry` are observations about right now. */
  minimumRuns: number;
}

/** On, at an hour, clearing at three, over five completed goals — roughly one goal's work on a three-wide fleet, so a dip between goals never trips it. */
export const DEFAULT_RUNWAY: RunwayPolicy = {
  enabled: true,
  warnHours: 1,
  clearHours: 3,
  minimumRuns: 5,
};

/** Refuse a policy that cannot do what it says, at load, naming the key. `clearHours` at or below `warnHours` is the one that matters: it does not fail, it flaps. */
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
  /** Goals held by the appraisal's profile question (issue #342). */
  profiles: number;
  /** Goals whose attempt cap is spent, parked on a person. */
  escalated: number;
  /** Live parts the standing plans would release between them. */
  parts: number;
}

/** What the pipeline looks like right now, and why. Derived, never stored. */
export interface RunwayReading {
  state: SupplyState;
  /** Minutes until the fleet has nothing to take, or null when no duration is honest — an empty queue, or too little history for a median. */
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
  /** The median goal lead time in minutes — **fleet time**, with spans a person was the next mover taken out. Null below `minimumRuns`. */
  medianLeadMinutes: number | null;
  /** The median goal's human wait, in minutes — what was taken out of the figure above, over the same runs. Zero is a real reading. */
  medianHeldMinutes: number | null;
  /** How many completed goals that median was taken over. */
  completedRuns: number;
  /** Completed goals the median could **not** be taken over: a span not finite and positive, or one covered end to end by holds. */
  unmeasuredRuns: number;
  /** Slots doing nothing this instant. Zero while paused, which is not idleness. */
  idleSlots: number;
  /** The row's one line, and what sits under it. Written here so the desk and the card cannot word it differently. */
  headline: string;
  detail: string;
}

/** Everything the reading is taken from. */
export interface RunwayInput {
  policy: RunwayPolicy;
  /** Every open issue the harness can see. The pickup verdict is taken **here**, through `issuePickupStatus`, never passed in already computed. */
  issues: readonly Issue[];
  /** The gate's own context — the *only* copy of the plans, parts and appraisal verdicts, read back out of it so no caller can hand the lens a different plan list from the gate's. */
  pickup: IssuePickupContext;
  /** Every run the floor holds — the completed ones are the median. */
  runs: readonly IssueRun[];
  /** **Every** bench row the store holds, settled ones included — the open ones are the debt count, the settled ones the human wait the median takes out. `supply` rows count for neither. */
  humanTasks: readonly HumanTask[];
  /** When each escalation stood, and the two context keys a goal can be reached through — {@link EscalationSpan}. Raw rather than resolved: which escalation stopped which goal is this lens's judgement. */
  escalations: readonly EscalationSpan[];
  /** The fleet's width, read by reference from `RuntimeControl` exactly as the pulse reads it. */
  cap: number;
  /** Whether a `supply` row is standing — the only state the hysteresis needs: entering the warn band takes `warnHours`, leaving it takes `clearHours`. */
  standing: boolean;
}

/** Statuses that mean the fleet is on it. */
const INFLIGHT = new Set(['active', 'has_pr', 'planning']);
/** Statuses that mean unstarted work the fleet may take. `blocked` is the healthiest reading on the card — more work than slots. `cooldown` is supply coming back. */
const QUEUED = new Set(['eligible', 'blocked', 'cooldown']);
/** Statuses that mean a person is the next mover. `appraisal` **cannot** be here: it covers both an issue about to be appraised and one left standing on a person, separated below by `appraisalHold`. */
const HELD = new Set(['escalated', 'delivered', 'retained']);

/** Take the reading. Pure over its input, so every state below is reachable in a test without a store, a clock or a fleet. */
export function readRunway(input: RunwayInput): RunwayReading {
  let inflight = 0;
  let queued = 0;
  let reservoir = 0;
  let reservoirContainers = 0;
  let held = 0;
  let escalated = 0;

  const appraisals = input.pickup.appraisals ?? [];
  const plans = input.pickup.plans ?? [];
  const planParts = input.pickup.planParts ?? [];

  for (const issue of input.issues) {
    const { status } = issuePickupStatus(issue, input.pickup);
    if (INFLIGHT.has(status)) inflight += 1;
    else if (QUEUED.has(status)) queued += 1;
    else if (status === 'appraisal') {
      // The split the status alone cannot make. A null hold is the pending arm —
      // the fleet has not got to it yet, which is what a queue *is*.
      const hold = appraisalHold(appraisals.find((a) => a.originRef === `issue:${issue.number}`) ?? null, issue, {
        signals: input.pickup.appraisalSignals ?? [],
      });
      if (hold === null) queued += 1;
      else held += 1;
    } else if (HELD.has(status)) {
      held += 1;
      if (status === 'escalated') escalated += 1;
    } else if (status === 'unwatched') reservoir += 1;
    else if (status === 'container' && issueWatchGateReason(issue, input.pickup.policy) !== null) {
      // Counted as a way in rather than as work: a container is never dispatched at,
      // but one watch write reaches every descendant — and those descendants are
      // already in the reservoir under their own numbers.
      reservoirContainers += 1;
    }
  }

  const {
    lead: medianLeadMinutes,
    held: medianHeldMinutes,
    measured: completedRuns,
    unmeasured: unmeasuredRuns,
  } = medianLead(input.runs, input.policy.minimumRuns, humanHolds(input));
  const supply = inflight + queued;
  const cap = Math.max(1, input.cap);
  // Off the pulse's own headroom, never `cap - inflight`: a goal with an open pull
  // request is in flight and holds no agent, so counting goals would report a
  // fully-staffed fleet as having spare capacity.
  const idleSlots = input.pickup.paused ? 0 : Math.max(0, input.pickup.headroom);
  const runwayMinutes =
    queued === 0 || medianLeadMinutes === null ? null : Math.round((supply * medianLeadMinutes) / cap);

  const latent: LatentSupply = {
    plans: plans.filter((p) => p.status === 'awaiting_approval').length,
    // The one hold with no row of its own: an unanswered profile proposal stops the
    // goal before there is a plan to hold anything. Same predicate as the queue rail.
    profiles: appraisals.filter((a) => a.proposedProfile !== null && a.profileAnsweredAt === null).length,
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
    unmeasuredRuns,
    idleSlots,
  };
  return { ...reading, ...say(reading, cap) };
}

/**
 * Which state, in the order the conditions settle each other. **`starved`
 * before `dry` before the duration arms** — load-bearing, since a fleet with
 * a free slot and an empty queue satisfies both of the first two. `unknown`
 * sits *below* them, since neither needs a median.
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
  // A paused fleet is idle because somebody stopped it — no news to them.
  if (!input.paused && input.queued === 0 && input.idleSlots > 0) return 'starved';
  if (input.queued === 0) return 'dry';
  if (input.runwayMinutes === null || input.medianLeadMinutes === null) return 'unknown';
  // The hysteresis: a standing row survives a partial recovery instead of settling
  // and re-filing on the next goal that finishes.
  const threshold = (input.standing ? input.policy.clearHours : input.policy.warnHours) * 60;
  return input.runwayMinutes < threshold ? 'thin' : 'healthy';
}

/**
 * The median completed run, in minutes of **fleet time** and of the human
 * wait taken out of it — both null below `minimum` readable runs. Two medians
 * over one surviving set, so they cannot end up taken over different goals.
 * A run whose whole span is covered by holds is **dropped**: zero fleet time
 * is evidence about the hold rows, not the fleet, and admitting it drags the
 * median toward zero.
 */
function medianLead(
  runs: readonly IssueRun[],
  minimum: number,
  holds: Map<string, Hold[]>,
): { lead: number | null; held: number | null; measured: number; unmeasured: number } {
  const done = runs.filter((r) => r.completedAt !== null);
  const completed = done.length;
  const pairs = done
    .map((r) => {
      const from = Date.parse(r.startedAt);
      const to = Date.parse(r.completedAt as string);
      const held = heldWithin(holds.get(r.originRef) ?? [], from, to);
      return { work: to - from - held, held };
    })
    // A backwards clock or an older build's row would otherwise put a negative span
    // in the middle of the sort.
    .filter((p) => Number.isFinite(p.work) && p.work > 0);
  // Both counts, so the `unknown` sentence can tell the two reasons apart: too few
  // completed goals, and enough of them whose spans went entirely to holds.
  const measured = pairs.length;
  const unmeasured = completed - measured;
  if (measured < minimum) return { lead: null, held: null, measured, unmeasured };
  return {
    lead: medianMinutes(pairs.map((p) => p.work)),
    held: medianMinutes(pairs.map((p) => p.held)),
    measured,
    unmeasured,
  };
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
 * one. A part's ref folds onto its goal deliberately: the lead time being measured
 * is the goal's.
 */
function goalOf(ref: string | null): string | null {
  const m = ref === null ? null : /^issue:(\d+)(?::|$)/.exec(ref);
  return m ? `issue:${m[1] as string}` : null;
}

/**
 * Whether a bench row means the fleet has stopped — narrower than whether
 * somebody owes something. `close_out`/`validate` — yes. `ask` — only when a
 * plan part (`partId` set); a standalone ask blocks nothing. `burn` — no, the
 * fleet works through it. `supply` — no, this reading must not describe itself.
 */
function benchRowHolds(t: HumanTask): boolean {
  if (t.kind === 'close_out' || t.kind === 'validate') return true;
  return t.kind === 'ask' && t.partId !== null;
}

/** Every human hold the input can evidence, filed under the goal it stopped. Taken off the raw rows: which rows mean "the fleet stopped" is the judgement the median is made of. */
function humanHolds(input: RunwayInput): Map<string, Hold[]> {
  const held = new Map<string, Hold[]>();
  const add = (ref: string | null, from: string, to: string | null): void => {
    const goal = goalOf(ref);
    const start = Date.parse(from);
    if (goal === null || !Number.isFinite(start)) return;
    const end = to === null ? NaN : Date.parse(to);
    const list = held.get(goal) ?? [];
    // A row whose end will not parse is read as still standing rather than dropped;
    // the clamp below stops that meaning more than the run it sits in.
    list.push({ from: start, to: Number.isFinite(end) ? end : null });
    held.set(goal, list);
  };

  for (const t of input.humanTasks) if (benchRowHolds(t)) add(t.originRef, t.createdAt, t.resolvedAt);
  // The appraisal's profile gate — the one hold with no row of its own. Asked
  // through `appraisalHold`, the same function the pickup gate and the queue bucket
  // ask; two matchers for one claim is how a reading disagrees with itself.
  const issuesByRef = new Map(input.issues.map((i) => [`issue:${i.number}`, i]));
  for (const a of input.pickup.appraisals ?? []) {
    // **The span is closed or it is nothing.** Read to the end of the run, an
    // unanswered proposal subtracts every minute a goal that demonstrably shipped
    // spent shipping. Only `decided_at → profile_answered_at` is evidenced here.
    if (a.profileAnsweredAt === null) continue;
    const issue = issuesByRef.get(a.originRef);
    if (!issue) continue;
    // Asked as of the hold's *start*, the only moment there is a hold to ask about:
    // with the answer in, the gate arm is released by construction. What it still
    // rules on is a ticket rewritten since — that goal was never held.
    if (
      appraisalHold({ ...a, profileAnsweredAt: null }, issue, { signals: input.pickup.appraisalSignals ?? [] }) === null
    )
      continue;
    add(a.originRef, a.decidedAt, a.profileAnsweredAt);
  }
  // A standing delivery has no end — it stops standing when the world moves, which
  // nothing records — so it runs to the end of the run, where the clamp puts it.
  for (const d of input.pickup.deliveries ?? []) add(d.originRef, d.decidedAt, null);
  const byPr = prGoals(input.runs);
  for (const e of input.escalations) {
    // Answered, or open right now. A *dismissed* escalation stamps no time, so when
    // its hold ended is recorded nowhere; counting it to the end of the run would
    // subtract an afternoon nobody waited.
    if (e.answeredAt === null && !e.open) continue;
    // Two handles, neither an origin column: `context.originRef` on the goal-work
    // arms, `prNumber` on the merge and reply arms, resolved via `linkedPrNumber`.
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

/** How much of `[from, to]` a person was the next mover for — the **union** of the holds, never their sum. Clamped to the run's own span first. */
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
 * The sentence, decided beside the numbers it is about — three surfaces draw
 * one reading and separately assembled sentences would drift from the
 * figures. **Latent supply leads whenever there is any** on every arm that
 * means the fleet has stopped. **The headline is a function of the state
 * alone; every figure lives in the detail** — the headline is
 * `recordHumanTask`'s dedup key, so a figure in it would re-file the row
 * (with a fresh notification) every time the queue moves by one issue.
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

  // `healthy` and `unknown` file nothing and exist to be drawn on the card; and
  // `unknown` says which reading it lacks, since "—" reads as a broken gauge.
  if (reading.state === 'unknown') {
    return {
      headline: 'Not enough history for a runway yet',
      detail:
        (reading.unmeasuredRuns > 0
          ? `${reading.completedRuns} of ${reading.completedRuns + reading.unmeasuredRuns} completed goals left ` +
            `fleet time to measure; a median lead time is taken over more. `
          : `${reading.completedRuns} goal${reading.completedRuns === 1 ? ' has' : 's have'} completed; a median ` +
            `lead time is taken over more. `) + `${reading.inflight} in flight, ${reading.queued} waiting.`,
    };
  }
  return {
    headline: 'Healthy',
    detail:
      `${reading.inflight} in flight, ${reading.queued} waiting.` +
      (reading.runwayMinutes === null ? '' : ` About ${humanMinutes(reading.runwayMinutes)} of work queued.`),
  };
}

/** What "fleet time" cost the figure beside it, or null when no evidenced hold touched the history — said in the same sentence, or the change reads as a broken gauge. */
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

/** What a pass decided, as data — so the decisions are testable without a store, on {@link burnPass}'s pattern. */
type RunwayStep =
  | { kind: 'file'; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string }
  /** A row **this desk** settled, standing again under the same wording. */
  | { kind: 'reopen'; taskId: string; detail: string };

/**
 * What this pulse owes: at most one open `supply` row, wearing the current
 * state's wording. **Exactly one row, and a state change replaces it** —
 * `recordHumanTask` dedups on the title, so changed wording is a new row and
 * settling the old one is obligatory. A row the *operator* answered is not
 * re-filed; one the desk settled is **reopened** when its wording comes round
 * again, told apart by {@link DESK_SETTLED} (`recordHumanTask`'s dedup
 * ignores status and would otherwise leave the row `done`).
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

  // The settle arm runs whether or not the watch is on, and before the file arm, so
  // a state change reads as one replacement rather than two rows in a race.
  for (const row of open) {
    if (row.title === wanted) continue;
    steps.push({
      kind: 'settle',
      taskId: row.id,
      status: 'done',
      resolution:
        DESK_SETTLED +
        (wanted === null
          ? `the queue recovered — ${input.reading.detail}`
          : `superseded: ${input.reading.headline.toLowerCase()}`),
    });
  }
  if (wanted === null) return steps;
  // Standing already under this wording: file again, since `recordHumanTask`
  // refreshes the figures. Answered already: leave it alone — being told twice is
  // the failure this module is most able to cause.
  const settled = input.existing.filter((t) => t.status !== 'open' && t.title === wanted);
  if (settled.some((t) => !deskSettled(t))) return steps;
  // Settled by this desk, and the state has come round again: reopen it, which
  // `recordHumanTask` cannot do — its dedup ignores status and would leave it `done`.
  const mine = settled[0];
  if (mine) steps.push({ kind: 'reopen', taskId: mine.id, detail: input.reading.detail });
  else steps.push({ kind: 'file', title: wanted, detail: input.reading.detail });
  return steps;
}

/** The states worth a person's attention. `healthy` is the goal and `unknown` has nothing to say yet. */
const FILES = new Set<SupplyState>(['thin', 'dry', 'starved']);
