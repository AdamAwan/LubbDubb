import type { Store } from '../store/store.js';
import { readRunway, runwayPass, type RunwayInput, type RunwayPolicy, type RunwayReading } from './runway.js';

/** What the desk needs beyond its own store reads — the pulse's, handed in. */
type DeskInput = Omit<RunwayInput, 'policy' | 'runs' | 'humanTasks' | 'standing'>;

/**
 * Where a thinning queue becomes something a person is told about, once a pulse.
 *
 * The desk half of {@link readRunway}, and thin for {@link SpendBurnDesk}'s
 * reason: every decision is in the two pure functions and this is the store round
 * trip around them. It writes `human_tasks` rows and nothing else — it dispatches
 * nobody, holds nothing, and no rule reads what it writes, which is what keeps a
 * lens about the dispatcher's own supply from becoming a second opinion about
 * dispatch.
 */
export class RunwayDesk {
  constructor(
    private readonly store: Store,
    private readonly policy: RunwayPolicy,
  ) {}

  /**
   * @public called by `Harness.runCycle`, beside the other bookkeeping passes.
   *
   * Returns the reading it took, because the pulse is the one caller that has
   * already paid for every input — the cockpit takes its own from the snapshot's
   * context, and the two agreeing is a property of the lens being one function
   * rather than of anything passed between them.
   */
  run(input: DeskInput): RunwayReading {
    const existing = this.store.listHumanTasksOfKind('supply');
    const reading = readRunway({
      ...input,
      policy: this.policy,
      runs: this.store.listIssueRuns(),
      humanTasks: this.store.listOpenHumanTasks(),
      // The hysteresis' only input, and the reason it needs no column: a row is
      // either standing or it is not, and which threshold applies follows from
      // that alone.
      standing: existing.some((t) => t.status === 'open'),
    });
    for (const step of runwayPass({ reading, existing, enabled: this.policy.enabled })) {
      if (step.kind === 'file')
        this.store.recordHumanTask({
          title: step.title,
          detail: step.detail,
          // Fleet-wide, like the recovery hold: this is not an ask about a goal,
          // and an origin here would file it onto whichever goal happened to be
          // last in the world.
          originRef: null,
          kind: 'supply',
          agentId: null,
          taskId: null,
        });
      else this.store.settleHumanTask(step.taskId, step.status, step.resolution);
    }
    return reading;
  }
}
