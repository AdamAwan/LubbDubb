/**
 * The account's allowance as a reading about *time* — what the usage chip could
 * never be.
 *
 * `account_rate_limits` answers "how much of the five hours is spent" and answers
 * it by discarding the previous reading on every turn, which is the right shape
 * for a chip and the wrong one for every question an operator actually asks next:
 * when did it climb, what was running while it did, and will the week reach its
 * reset. `rate_limit_readings` keeps the same figures as a series
 * ([14](../docs/spec/14-persistence.md)), and this is the fold over it.
 *
 * ## Percentage is not money, and the difference is the whole design
 *
 * The harness already prices a goal to the cent, and that reading is *measured*:
 * every dollar has an agent's name on it. The account's percentage has no name on
 * it at all — it is one global counter, moved by every agent at once and by the
 * operator's own Claude Code on the same account, and no event says which turn
 * moved it. So nothing here measures a percentage per goal. It **apportions** one,
 * and says so:
 *
 * - The rise is taken between consecutive readings, so the unit of attribution is
 *   a few minutes rather than the whole window. Within one interval the model mix
 *   is whatever it is; across a window it moves, and a single window-wide split by
 *   cost share would silently absorb that drift. This is the reason the fold is
 *   per interval and not one division at the end.
 * - Each interval's rise is split between the goals whose agents *reported cost
 *   inside that interval*, by their share of it. An interval with no fleet spend
 *   in it attributes nothing — its rise is the operator's own session, or an
 *   agent the harness cannot see, and pretending otherwise is the one lie this
 *   module exists to avoid telling.
 * - What is left is {@link AllowanceApportionment.unattributedPoints}, and it is
 *   carried rather than divided up. `EconomicsTab`'s `unattributedCostUsd` is the
 *   same decision about the same kind of remainder.
 *
 * A local run's money is real spend on the same account, but its dated deltas
 * carry no run id ({@link CostDelta}), so it can never name a goal. It therefore
 * counts in the denominator of an interval — it did move the account — and its
 * share lands in the residual rather than inflating whichever goals happened to
 * be running. The alternative is a goal charged for an operator's own afternoon.
 *
 * ## Resets, and why a fall is never a negative
 *
 * A window reset is a fall in the percentage, and the account's five-hour window
 * resets four or five times a day. A delta taken blind would net those falls
 * against the rises and report a fleet that spent almost nothing. Every fall is
 * therefore read as a reset boundary and contributes zero, so the window's total
 * is the sum of its segments — which is what "spent in this window" means when
 * the allowance refilled inside it.
 *
 * ## A gap is not a reset
 *
 * A reading arrives only when an agent takes a turn, so an idle fleet produces
 * none at all while the real window keeps moving. The rise across such a gap is
 * **counted** — it happened — and attributes to nobody, which is exactly how the
 * operator's own session shows up in the reading. What the gap changes is the
 * drawing: {@link AllowanceReading.afterGap} tells the cockpit not to join two
 * readings an hour apart with a line that claims to know what happened between
 * them.
 *
 * → docs/spec/18-observability.md#the-allowance, docs/spec/17-cockpit.md#allowance
 */

import type { AccountRateLimits, Agent, TaskSummary, UsageEvent, WorldEvent } from './types.js';
import type { SpendGoal } from './spendInsights.js';
// `roundUsd` rounds a float sum, not a currency: a percentage accumulated over a
// hundred intervals ships `13.999999999999998` for exactly the reason a dollar
// total does, and one rounding keeps every reader of the wire on one figure.
import { issueBehind, roundUsd, unmeasured } from './issueSpend.js';
import type { InsightsWindowView } from './insightsWindow.js';

/**
 * How long a silence has to run before two readings stop being joined.
 *
 * Well above a turn and well below a park: a stream agent reports on every turn,
 * so a working fleet's readings are minutes apart, and anything past this is the
 * fleet not running rather than a turn taking a while. It is a *drawing*
 * threshold and nothing else — no total, share or projection reads it — so
 * getting it slightly wrong costs a line segment, not a figure.
 */
const GAP_MS = 15 * 60_000;

/**
 * The stretch the burn-down's rate is fitted over.
 *
 * Not the whole seven days, and that is the point: the question is whether *this
 * week's current* pace reaches the limit before the reset, and a quiet Monday
 * folded into the average is how a fleet that has been flat out since Thursday
 * reports that it has days of headroom left. Two days is long enough to survive
 * one busy afternoon and short enough to notice a change of pace.
 */
const FIT_MS = 48 * 3_600_000;

/** Below this many readings in the fit stretch there is no line to fit, only two dots. */
const MIN_FIT_READINGS = 3;

/**
 * How many voices the goal palette has.
 *
 * Server-side because the *assignment* is, and the two must agree: the stylesheet
 * declares `--al-goal-0` through `--al-goal-4`, and a fold handing out a sixth
 * slot would name a custom property nothing declares — which `var()` answers with
 * silence, not with an error.
 */
const SLOTS = 5;

/** One reading, as the cockpit draws it. */
export interface AllowanceReading {
  /** The instant the reading was captured — `capturedAt`, not when it was stored. */
  at: string;
  /** The five-hour window's used percentage, or null where the CLI named none. */
  fiveHour: number | null;
  sevenDay: number | null;
  /**
   * Whether the previous reading is far enough back ({@link GAP_MS}) that nothing
   * should be drawn between them. False on the first reading, which has no
   * predecessor to be far from.
   */
  afterGap: boolean;
  /**
   * Whether the five-hour window reset between this reading and the one before —
   * a fall in the percentage. The cockpit breaks the line here rather than
   * drawing a cliff, which would read as the fleet having given something back.
   */
  afterReset: boolean;
}

/**
 * One agent run, as a lane under the timeline.
 *
 * The lanes are the whole of the timeline's argument: they let a reader see which
 * agents were running while the line climbed, without the chart ever claiming
 * that the tallest one caused it. Adjacency is not attribution, and a lane is
 * adjacency drawn honestly.
 */
export interface AllowanceLane {
  /** The agent's id — what the cockpit's drawer opens on. */
  agentId: string;
  /** What the agent was asked to do, for the lane's label. */
  title: string | null;
  /** The goal its money was folded into, or null where it reached none. */
  issueNumber: number | null;
  /**
   * The goal's colour slot, or null where the run reached no goal — which the
   * cockpit draws in the residual's grey rather than in a voice of its own.
   */
  slot: number | null;
  startedAt: string;
  /** Null while it is still running, which the cockpit draws as running to `now`. */
  endedAt: string | null;
  /**
   * Whether the run reported any usage at all. A PTY agent reports none, so it
   * gets a lane — it was running, which is what a lane says — and is drawn muted:
   * it moved the account by nothing this harness can see.
   */
  measured: boolean;
}

/** One goal's apportioned share of the window's allowance, and what it landed. */
export interface AllowanceGoal {
  issueNumber: number;
  originRef: string;
  title: string | null;
  /**
   * Which of the palette's {@link SLOTS} voices draws this goal, on the bar, in
   * its lanes and in the table.
   *
   * Assigned here rather than in the browser so the three surfaces cannot
   * disagree, and derived from the issue number so a goal keeps its colour across
   * a redraw — but **collisions are resolved to the next free slot**, which is the
   * trade this field exists to make. Modulo alone put `#412` and `#417` in one
   * voice, adjacent on the bar and identical in the table, and a legend whose
   * swatch matches two rows is not a legend. With more goals than voices some
   * repainting is unavoidable; drawing two of them the same never is.
   */
  slot: number;
  /** The goal's measured cost inside the window — the share's basis, and a fact. */
  costUsd: number;
  /**
   * Points of the account's five-hour allowance apportioned to this goal.
   *
   * A point is one percent of the window. Apportioned, never measured — see the
   * module note.
   */
  points: number;
  /** Pull requests merged inside the window whose lineage reaches this goal. */
  landed: number;
  /**
   * {@link AllowanceGoal.points} per landed change, or **null where nothing
   * landed**.
   *
   * Null rather than `Infinity`, for `EconomicsTab`'s reason: a goal that
   * consumed a tenth of the account and landed nothing is the single most
   * important row this table draws, and it has to render as the sentence it is
   * rather than as a symbol.
   */
  pointsPerLanded: number | null;
}

/** The window's rise, and who it is charged to. */
export interface AllowanceApportionment {
  /**
   * The rise across the window's readings — the sum of the positive steps, with
   * every reset boundary contributing zero.
   *
   * Null where there are fewer than two readings: one reading is a level, not a
   * change, and reporting zero for it would say the account did not move when
   * what happened is that nothing watched it.
   */
  observedPoints: number | null;
  /** The part of {@link observedPoints} that reached a goal. */
  attributedPoints: number;
  /** The rest of it: intervals with no attributable fleet spend, and local runs. */
  unattributedPoints: number;
  /**
   * Points of allowance per dollar the fleet spent, over this window.
   *
   * The calibration the whole apportionment rests on, shipped because it is worth
   * reading on its own: it moves with the model mix, and a figure that drifts is
   * telling an operator that something outside the fleet is eating the account.
   * Null when the window measured no spend, which is not a rate of zero.
   */
  pointsPerUsd: number | null;
  /** Apportioned-costliest first. */
  goals: AllowanceGoal[];
}

/**
 * The weekly burn-down: does this pace reach the limit before the window resets.
 *
 * The one reading here that can be acted on *before* the fact, which is why it is
 * built even when the page's own window is five hours — it is always about the
 * seven-day window, and an operator who changes the cap because of it changes it
 * for the week rather than for the afternoon.
 */
export interface AllowanceProjection {
  /** The freshest seven-day reading's used percentage. */
  usedPercentage: number;
  /** When that reading was taken — the projection is exactly as stale as this. */
  capturedAt: string;
  /** When the weekly window resets, where the CLI reported it. */
  resetsAt: string | null;
  /**
   * Points per hour over {@link FIT_MS}, or null where the stretch held too few
   * readings to fit ({@link MIN_FIT_READINGS}) or the account did not rise in it.
   */
  ratePerHour: number | null;
  /** When the allowance reaches 100% at that rate, or null where there is no rate. */
  exhaustsAt: string | null;
  /**
   * Whether exhaustion lands before the reset — the reading in one field.
   *
   * Null where either date is unknown, and never guessed: a projection with no
   * reset to beat is a slope, and drawing it as a verdict would invent the half
   * the CLI did not report.
   */
  beforeReset: boolean | null;
  /** How many readings the fit was over, so the cockpit can say how thin it is. */
  fittedFrom: number;
}

export interface AllowanceInsights {
  generatedAt: string;
  /** The stretch the readings and the apportionment were taken over. */
  window: InsightsWindowView;
  /** The readings inside the window, oldest first. */
  readings: AllowanceReading[];
  /** Every agent run in the window, most recently started first. */
  lanes: AllowanceLane[];
  apportionment: AllowanceApportionment;
  /**
   * The weekly burn-down, or null on a deployment whose readings carry no
   * seven-day window at all — API-key auth, or a CLI too old to report one.
   */
  projection: AllowanceProjection | null;
}

interface AllowanceInput {
  /** The readings inside the page's window, oldest first. */
  readings: readonly AccountRateLimits[];
  /**
   * The readings over the last {@link FIT_MS} and more, for the projection alone.
   *
   * A second list rather than a slice of the first, because the burn-down is not
   * about the page's window: an operator reading the five-hour session still
   * needs to know whether the *week* survives, and slicing a five-hour list for a
   * two-day fit would give a projection that silently narrowed with the control.
   */
  weekReadings: readonly AccountRateLimits[];
  /**
   * The agents' dated cost deltas inside the window — the only source that says
   * **whose** money went out and when, which is what an interval split needs.
   */
  usageEvents: readonly UsageEvent[];
  /**
   * Every dated delta whatever spent it, for the interval denominator. The
   * difference from {@link usageEvents} is exactly the local runs, whose money
   * moved the account and can name no goal.
   */
  costDeltas: readonly { costUsd: number; at: string }[];
  /** The window's agent runs, for the lanes. */
  agents: readonly Agent[];
  /** Task titles and origins — the lane labels, and the goal behind each run. */
  tasks: readonly TaskSummary[];
  /** The work graph, for the lineage a pull request's merge is charged through. */
  nodes: readonly { ref: string; parentRef: string | null }[];
  /** The goals the spend fold already rolled up, for titles and windowed cost. */
  goals: readonly SpendGoal[];
  /** Which goal each agent's money was folded into — the spend fold's own answer. */
  attribution: ReadonlyMap<string, number | null>;
  /** `pr_merged` inside the window, for the landed column. */
  mergeEvents: readonly WorldEvent[];
  window: InsightsWindowView;
  now: number;
}

export function buildAllowanceInsights(input: AllowanceInput): AllowanceInsights {
  const { readings, agents, tasks, attribution, window, now } = input;
  const titleOfTask = new Map(tasks.map((t) => [t.id, t.title]));
  const apportionment = apportion(input);
  // The lanes take the apportionment's own slots rather than deriving their own:
  // a lane and the bar segment above it are the same goal, and two independent
  // assignments of one palette is the disagreement the field exists to prevent.
  const slotOfGoal = new Map(apportionment.goals.map((goal) => [goal.issueNumber, goal.slot]));

  return {
    generatedAt: new Date(now).toISOString(),
    window,
    readings: markReadings(readings),
    lanes: agents
      .map((agent): AllowanceLane => {
        const issueNumber = attribution.get(agent.id) ?? null;
        return {
          agentId: agent.id,
          title: titleOfTask.get(agent.taskId) ?? null,
          issueNumber,
          slot: issueNumber === null ? null : (slotOfGoal.get(issueNumber) ?? null),
          startedAt: agent.startedAt,
          endedAt: agent.endedAt,
          measured: !unmeasured(agent),
        };
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    apportionment,
    projection: project(input.weekReadings, now),
  };
}

/**
 * The readings with their two drawing flags on them.
 *
 * Computed here rather than in the browser for the reason every other split is:
 * the reset test and the gap threshold are statements about what the data means,
 * and a cockpit free to pick its own would draw a line the server's own totals
 * disagree with.
 */
function markReadings(readings: readonly AccountRateLimits[]): AllowanceReading[] {
  return readings.map((reading, i) => {
    const previous = readings[i - 1] ?? null;
    const used = reading.fiveHour?.usedPercentage ?? null;
    const before = previous?.fiveHour?.usedPercentage ?? null;
    return {
      at: reading.capturedAt,
      fiveHour: used,
      sevenDay: reading.sevenDay?.usedPercentage ?? null,
      afterGap: previous !== null && Date.parse(reading.capturedAt) - Date.parse(previous.capturedAt) > GAP_MS,
      // Both readings have to carry a percentage for a fall to mean anything —
      // a window that went from unreported to reported is not a reset.
      afterReset: used !== null && before !== null && used < before,
    };
  });
}

/**
 * Split each interval's rise among the goals that were spending inside it.
 *
 * The loop is over *intervals* rather than over goals, which is the shape the
 * honesty rests on: a goal's share is only ever taken from the rise that happened
 * while it was reporting cost, so a goal that ran for ten minutes of a five-hour
 * window can never be charged for the other four hours and fifty.
 */
function apportion(input: AllowanceInput): AllowanceApportionment {
  const { readings, usageEvents, costDeltas, agents, goals, attribution, nodes } = input;
  const points = new Map<number, number>();
  let observed = 0;
  let unattributed = 0;
  let attributed = 0;

  // The deltas dated once, so the interval scan is not re-parsing ISO strings
  // inside a nested loop over every reading.
  const goalOfAgent = new Map(agents.map((a) => [a.id, attribution.get(a.id) ?? null]));
  const agentSpend = usageEvents.map((e) => ({ at: Date.parse(e.at), costUsd: e.costUsd, agentId: e.agentId }));
  const allSpend = costDeltas.map((d) => ({ at: Date.parse(d.at), costUsd: d.costUsd }));

  for (let i = 1; i < readings.length; i++) {
    const from = readings[i - 1];
    const to = readings[i];
    const before = from?.fiveHour?.usedPercentage ?? null;
    const after = to?.fiveHour?.usedPercentage ?? null;
    // A reading with no five-hour figure spans nothing: there is no rise to
    // charge, and inventing one from the readings either side of it would put a
    // number on the one stretch the CLI declined to describe.
    if (from === undefined || to === undefined || before === null || after === null) continue;
    const rise = after - before;
    // A fall is a reset boundary and contributes zero — see the module note.
    if (rise <= 0) continue;
    observed += rise;

    const startMs = Date.parse(from.capturedAt);
    const endMs = Date.parse(to.capturedAt);
    // Every dollar that went out inside the interval, whoever spent it. The
    // denominator is the *total*, so a local run's share dilutes the goals'
    // rather than being left out of a split it genuinely belongs in.
    const total = allSpend.reduce((sum, d) => (d.at > startMs && d.at <= endMs ? sum + d.costUsd : sum), 0);
    if (total <= 0) {
      // Nothing of ours was spending, and the account still moved. This is the
      // operator's own session, and it is the reading that must not be divided up.
      unattributed += rise;
      continue;
    }
    let charged = 0;
    for (const spend of agentSpend) {
      if (spend.at <= startMs || spend.at > endMs) continue;
      const issueNumber = goalOfAgent.get(spend.agentId) ?? null;
      if (issueNumber === null) continue;
      const share = (rise * spend.costUsd) / total;
      points.set(issueNumber, (points.get(issueNumber) ?? 0) + share);
      charged += share;
    }
    attributed += charged;
    // Whatever the split did not reach: a local run, or an agent whose money
    // never found a goal. The subtraction is what keeps the three totals adding
    // up however the shares fell.
    unattributed += rise - charged;
  }

  const landed = landedByGoal(input.mergeEvents, nodes);
  const costUsd = goals.reduce((sum, goal) => sum + goal.costUsd, 0);
  const rows = goals
    .map((goal) => {
      const share = roundUsd(points.get(goal.issueNumber) ?? 0);
      const merged = landed.get(goal.issueNumber) ?? 0;
      return {
        issueNumber: goal.issueNumber,
        originRef: goal.originRef,
        title: goal.title,
        costUsd: goal.costUsd,
        points: share,
        landed: merged,
        pointsPerLanded: merged > 0 ? roundUsd(share / merged) : null,
      };
    })
    // A goal that was apportioned nothing is a goal that did not spend inside the
    // window — it belongs to the spend fold's list, not to this one.
    .filter((goal) => goal.points > 0)
    .sort((a, b) => b.points - a.points || a.issueNumber - b.issueNumber);
  const slots = assignSlots(rows.map((row) => row.issueNumber));
  const withSlots = rows.map((row): AllowanceGoal => ({ ...row, slot: slots.get(row.issueNumber) ?? 0 }));

  return {
    observedPoints: readings.length < 2 ? null : roundUsd(observed),
    attributedPoints: roundUsd(attributed),
    unattributedPoints: roundUsd(unattributed),
    pointsPerUsd: costUsd > 0 ? roundUsd(observed / costUsd) : null,
    goals: withSlots,
  };
}

/**
 * A colour slot per goal: its own where the palette has room, the next free one
 * where it does not.
 *
 * `issueNumber % SLOTS` first, so a goal keeps its voice from one draw of the tab
 * to the next. Where two goals want one voice the later of them takes the next
 * free slot, because two rows drawn identically is a legend that has stopped
 * being one — and with more goals than voices, that is a failure the reader
 * cannot even see, whereas a goal whose colour moved between windows is one they
 * can. Beyond {@link SLOTS} goals the voices are reused, which is the honest end
 * of a five-colour palette.
 */
function assignSlots(issueNumbers: readonly number[]): Map<number, number> {
  const taken = new Set<number>();
  const slots = new Map<number, number>();
  for (const issueNumber of issueNumbers) {
    const wanted = issueNumber % SLOTS;
    let slot = wanted;
    for (let hop = 1; taken.has(slot) && hop < SLOTS; hop++) slot = (wanted + hop) % SLOTS;
    taken.add(slot);
    slots.set(issueNumber, slot);
  }
  return slots;
}

/**
 * Merges inside the window, charged to the goal their lineage reaches.
 *
 * The same walk the money takes ({@link issueBehind}), and deliberately so: a
 * per-landed figure whose numerator and denominator disagreed about which goal a
 * pull request belongs to would be a ratio between two different goals.
 */
function landedByGoal(
  mergeEvents: readonly WorldEvent[],
  nodes: readonly { ref: string; parentRef: string | null }[],
): Map<number, number> {
  const parentOf = new Map(nodes.map((n) => [n.ref, n.parentRef]));
  const landed = new Map<number, number>();
  for (const event of mergeEvents) {
    if (event.ref === null) continue;
    const issueNumber = issueBehind(event.ref, parentOf);
    if (issueNumber === null) continue;
    landed.set(issueNumber, (landed.get(issueNumber) ?? 0) + 1);
  }
  return landed;
}

/**
 * The weekly burn-down, fitted over the last {@link FIT_MS}.
 *
 * The fit starts at the **last reset inside the stretch** where there is one: a
 * rate taken across a refill is the account's whole week averaged against a fresh
 * allowance, which reads as a fleet that has stopped spending.
 */
function project(weekReadings: readonly AccountRateLimits[], now: number): AllowanceProjection | null {
  const withWeek = weekReadings.filter((r) => r.sevenDay !== null);
  const latest = withWeek.at(-1);
  if (latest === undefined || latest.sevenDay === null) return null;

  let fit = withWeek.filter((r) => now - Date.parse(r.capturedAt) <= FIT_MS);
  // Everything from the last fall onwards — the current allowance's own history.
  for (let i = fit.length - 1; i > 0; i--) {
    const used = fit[i]?.sevenDay?.usedPercentage ?? 0;
    const before = fit[i - 1]?.sevenDay?.usedPercentage ?? 0;
    if (used < before) {
      fit = fit.slice(i);
      break;
    }
  }

  const first = fit[0];
  const usedPercentage = latest.sevenDay.usedPercentage;
  const resetsAt = latest.sevenDay.resetsAt;
  const base: AllowanceProjection = {
    usedPercentage,
    capturedAt: latest.capturedAt,
    resetsAt,
    ratePerHour: null,
    exhaustsAt: null,
    beforeReset: null,
    fittedFrom: fit.length,
  };
  if (fit.length < MIN_FIT_READINGS || first === undefined) return base;

  const hours = (Date.parse(latest.capturedAt) - Date.parse(first.capturedAt)) / 3_600_000;
  const rise = usedPercentage - (first.sevenDay?.usedPercentage ?? 0);
  // A flat or falling fit has no exhaustion to name. Reporting one anyway — at a
  // rate of nearly zero, arriving in four hundred hours — is a date that is worse
  // than no date: it renders, and it is read.
  if (hours <= 0 || rise <= 0) return base;

  const ratePerHour = rise / hours;
  const exhaustsAt = new Date(now + ((100 - usedPercentage) / ratePerHour) * 3_600_000).toISOString();
  return {
    ...base,
    ratePerHour: roundUsd(ratePerHour),
    exhaustsAt,
    beforeReset: resetsAt === null ? null : Date.parse(exhaustsAt) < Date.parse(resetsAt),
  };
}
