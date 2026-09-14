import type { Store } from '../store/store.js';
import { readRunway, runwayPass, type RunwayInput, type RunwayPolicy, type RunwayReading } from './runway.js';

// → docs/spec/25-supply.md

type DeskInput = Omit<RunwayInput, 'policy' | 'runs' | 'humanTasks' | 'escalations' | 'standing'>;

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
    const existing = this.store.humanTasks.listHumanTasksOfKind('supply');
    const reading = readRunway({
      ...input,
      policy: this.policy,
      runs: this.store.floor.listIssueRuns(),
      humanTasks: this.store.humanTasks.listAllHumanTasks(),
      escalations: this.store.escalations.listEscalationSpans(),
      standing: existing.some((t) => t.status === 'open'),
    });
    for (const step of runwayPass({ reading, existing, enabled: this.policy.enabled })) {
      if (step.kind === 'file')
        this.store.humanTasks.recordHumanTask({
          title: step.title,
          detail: step.detail,
          originRef: null,
          kind: 'supply',
          agentId: null,
          taskId: null,
        });
      else if (step.kind === 'reopen') this.store.humanTasks.reopenHumanTask(step.taskId, step.detail);
      else this.store.humanTasks.settleHumanTask(step.taskId, step.status, step.resolution);
    }
    return reading;
  }
}
