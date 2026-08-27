import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { EnvironmentReachStatus, GoalLanding, WorldSnapshot } from '../types.js';
import { announceableArrivals, arrivalComment, newArrivals } from './arrival.js';
import { unrecordedLandings } from './landings.js';
import type { EnvironmentConfig } from './policy.js';
import type { EnvironmentProber } from './prober.js';
import { allGoalReach } from './reach.js';
import type { WatchDesk } from './watchDesk.js';

interface EnvironmentDeskDeps {
  store: Store;
  /** The operator's list. Empty is the off switch — only the attribution pass runs. */
  environments: EnvironmentConfig[];
  prober: EnvironmentProber;
  /** Answers "is this landing in what the environment named", from the local clone. */
  git: GitObserver;
  /** Where an arrival's comment goes. */
  sink: ActionSink;
  /** How long a landing rests before its environment is asked where it is again. */
  probeIntervalMs: number;
  /**
   * The post-deploy watch's own pass, or undefined where nothing has one.
   *
   * Held here rather than run beside this desk in the composition root, because
   * **where it runs is the invariant**: a window opens on an arrival the pass above
   * records, so above that pass it reads arrivals that have not been written yet
   * and the whole feature is one pulse late forever, with nothing red. Making the
   * order a line in this file is what stops a reordering elsewhere being silent.
   * → `docs/spec/29-post-deploy-watch.md#the-window`
   */
  watch?: WatchDesk;
  errors?: ErrorRecorder;
  /** Injectable clock, so a test decides what "due" means rather than waiting. */
  now?: () => number;
}

/**
 * How many landings one environment may be asked about per pulse.
 *
 * The bound is on the *git* half now, not the probe: an environment is asked
 * where it is exactly once per pulse however many goals are in flight, and what
 * is left to scale is the reachability question the clone answers. That is two
 * process spawns for the whole batch, so this is generous — it exists so a
 * deployment turning the feature on over a year of history does the backfill in
 * pulses rather than in one command line thousands of arguments long.
 *
 * Deferring rather than dropping: what this leaves out is asked on the next
 * pulse, oldest landing first, so the queue drains in a fixed order.
 */
const MAX_LANDINGS_PER_PULSE = 200;

/**
 * Five passes on the pulse: attribute the merges nothing has attributed yet, ask
 * each environment where it is, record the goals that have just arrived, say so on
 * their tickets, and — last, because it reads what the third pass wrote — open,
 * read and settle the post-deploy watch.
 *
 * A desk beside {@link BranchReapDesk} rather than a dispatcher rule, for the
 * reason everything in `src/environments/` sits outside `src/dispatcher/`: it
 * staffs nothing, decides no dispatch, and no rule reads what it writes. What it
 * does gate — the `validate` and `close_out` obligations — it gates by writing a
 * row two desks read, not by deciding anything itself.
 * → `docs/spec/24-environments.md`
 *
 * A failure is recorded and never fails the cycle.
 */
export class EnvironmentDesk {
  private readonly now: () => number;

  constructor(private readonly deps: EnvironmentDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async run(world: WorldSnapshot): Promise<void> {
    const { store, errors } = this.deps;
    // The attribution runs even with no environments configured. It is the half
    // that cannot be done later: the merge SHA is only on offer while the pull
    // request is inside `closedPrWindowMs`, so a deployment that configures its
    // first environment next month still has this month's landings to ask about.
    try {
      for (const landing of unrecordedLandings({ world, nodes: store.listWorkNodes(), landed: store.landedPrs() }))
        store.recordGoalLanding(landing);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `recording goal landings failed: ${(err as Error).message}` });
    }

    if (this.deps.environments.length === 0) return;
    for (const environment of this.deps.environments) await this.probe(environment);
    this.recordArrivals();
    await this.announce();
    // Below the arrival pass, and that is the invariant rather than a preference:
    // a window opens on an arrival the pass above writes.
    await this.deps.watch?.run();
  }

  /**
   * Ask one environment where it is, and answer every landing it has not
   * confirmed from what it said.
   *
   * **One spawn for the environment and two for the clone, whatever the fleet is
   * doing.** The old shape asked "do you have this commit" once per landing per
   * environment per pulse, so the cost of the subsystem grew with every goal that
   * had ever merged; this one asks a question whose answer serves all of them.
   *
   * A probe that could not answer writes `unknown` against every landing it was
   * going to answer for, rather than leaving them untouched: an environment that
   * has gone dark is a thing the cockpit has to be able to say, and silence there
   * is indistinguishable from nobody having got round to it.
   */
  private async probe(environment: EnvironmentConfig): Promise<void> {
    const { store, errors } = this.deps;
    const pending = this.due(environment.name);
    if (pending.length === 0) return;
    try {
      const head = await this.deps.prober.at(environment.name, environment.at);
      const detail = head.detail;
      const held =
        head.commits === null
          ? new Map<string, boolean | null>()
          : await this.deps.git.contains(
              pending.map((l) => l.sha),
              head.commits,
            );
      for (const landing of pending) {
        const answer = head.commits === null ? null : (held.get(landing.sha) ?? null);
        store.recordEnvironmentReach({
          sha: landing.sha,
          environment: environment.name,
          status: verdictOf(answer),
          detail: answer === null ? (detail ?? 'the clone could not place this commit') : null,
        });
      }
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `probing ${environment.name} failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * The landings worth asking this environment about, oldest first and capped.
   *
   * **A `reached` verdict is never re-asked.** That is what makes the steady state
   * cost nothing beyond the one spawn: an established deployment's landings are
   * almost all confirmed everywhere, and the only live questions are this week's.
   * The price is that a rollback is not detected — an environment that goes back
   * past a commit still reads as holding it. Cheaper to revisit now than it was
   * under the old probe, and still a deliberate trade.
   */
  private due(environment: string): GoalLanding[] {
    const held = new Map(
      this.deps.store
        .listEnvironmentReach()
        .filter((r) => r.environment === environment)
        .map((r) => [r.sha, r]),
    );
    const floor = new Date(this.now() - this.deps.probeIntervalMs).toISOString();
    const out: GoalLanding[] = [];
    for (const landing of this.deps.store.listGoalLandings()) {
      const reading = held.get(landing.sha);
      if (reading?.status === 'reached') continue;
      if (reading !== undefined && reading.observedAt > floor) continue;
      out.push(landing);
      if (out.length >= MAX_LANDINGS_PER_PULSE) break;
    }
    return out;
  }

  /**
   * Write down the goals whose whole work is now somewhere it was not.
   *
   * Off the same fold the cockpit's panel is drawn from ({@link allGoalReach}),
   * because a comment posted on a ticket and a card claiming the goal is not there
   * yet would be the two halves of one question answering differently.
   */
  private recordArrivals(): void {
    const { store, errors } = this.deps;
    try {
      const reach = allGoalReach({
        landings: store.listGoalLandings(),
        readings: store.listEnvironmentReach(),
        nodes: store.listWorkNodes(),
        landed: store.landedPrs(),
        // Same denominator the panel is drawn from: a goal whose plan still owes a
        // part has not arrived anywhere, so nothing is written down and no comment
        // goes out until the last of its work is there.
        plans: store.listPlans(),
        parts: store.listAllPlanParts(),
        environments: this.deps.environments,
      });
      for (const arrival of newArrivals({ reach, recorded: store.listGoalArrivals() }))
        store.recordGoalArrival(arrival);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `recording goal arrivals failed: ${(err as Error).message}` });
    }
  }

  /**
   * Say on the ticket that the work got there — once, and only for an arrival
   * this harness watched happen.
   *
   * Mechanical bookkeeping in `setWorkItemState`'s sense and deliberately not
   * auto-send gated: nothing here is deciding *whether* the work arrived, and the
   * comment states a fact the harness already holds. What keeps that from being a
   * licence to chatter is that an arrival is recorded once and stamped whether or
   * not it had anything to say.
   *
   * The stamp goes down **after** the write, so a failure leaves the arrival for
   * the next pulse rather than marking it said.
   */
  private async announce(): Promise<void> {
    const { store, errors } = this.deps;
    const landings = store.listGoalLandings();
    for (const { arrival, comment } of announceableArrivals({
      arrivals: store.listGoalArrivals(),
      environments: this.deps.environments,
      readings: store.listEnvironmentReach(),
      landings,
      probeIntervalMs: this.deps.probeIntervalMs,
      now: this.now(),
    })) {
      const number = issueNumber(arrival.goalRef);
      if (comment && number !== null) {
        try {
          await this.deps.sink.upsertIssueComment({
            number,
            body: arrivalComment({
              environment: arrival.environment,
              landings: landings.filter((l) => l.goalRef === arrival.goalRef).length,
              at: arrival.arrivedAt,
            }),
            commentRef: null,
          });
        } catch (err) {
          errors?.record({
            source: 'cycle',
            message: `commenting on ${arrival.goalRef} reaching ${arrival.environment} failed: ${(err as Error).message}`,
          });
          continue;
        }
      }
      store.markArrivalAnnounced(arrival.goalRef, arrival.environment);
    }
  }
}

/**
 * The clone's answer, in the vocabulary the cockpit reads. `null` is `unknown`
 * and never `absent`: an object this checkout has not fetched and a commit that
 * genuinely has not shipped exit the same way, and only one of them is about
 * deployment. → `docs/spec/24-environments.md#the-three-verdicts`
 */
function verdictOf(answer: boolean | null): EnvironmentReachStatus {
  if (answer === null) return 'unknown';
  return answer ? 'reached' : 'absent';
}

function issueNumber(goalRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(goalRef);
  return m?.[1] === undefined ? null : Number(m[1]);
}
