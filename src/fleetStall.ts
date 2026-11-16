import type { ErrorRecorder } from './errorLog.js';
import type { Decision, FleetStall } from './types.js';

// → docs/spec/04-harness-cycle.md#when-the-fleet-stops-dispatching

interface StallCycle {
  at: string;
  /** Origins the dispatcher put above the cut-line this cycle: status `dispatching`. */
  dispatching: string[];
  paused: boolean;
  limitParked: boolean;
  /** Every decision this cycle recorded. */
  decisions: Decision[];
}

interface Streak {
  since: string;
  cycles: number;
  raised: boolean;
}

export class FleetStallWatch {
  private streak: Streak | null = null;
  private current: FleetStall | null = null;

  constructor(private readonly deps: { errors: ErrorRecorder; afterCycles: number }) {}

  observe(cycle: StallCycle): void {
    const dispatches = cycle.decisions.filter(
      (d) => d.action.type === 'dispatch_code_agent' || d.action.type === 'dispatch_desk_agent',
    );
    const started = dispatches.some((d) => d.outcome === 'executed');
    const starved =
      this.deps.afterCycles > 0 && !cycle.paused && !cycle.limitParked && cycle.dispatching.length > 0 && !started;
    if (!starved) {
      this.streak = null;
      this.current = null;
      return;
    }
    const streak = this.streak ?? { since: cycle.at, cycles: 0, raised: false };
    this.streak = streak;
    streak.cycles += 1;
    if (streak.cycles < this.deps.afterCycles) return;
    const refusal = dispatches.find((d) => d.outcome !== 'executed')?.detail ?? null;
    this.current = { since: streak.since, cycles: streak.cycles, candidates: cycle.dispatching, refusal };
    if (streak.raised) return;
    streak.raised = true;
    const n = cycle.dispatching.length;
    this.deps.errors.record({
      source: 'cycle',
      message:
        `The fleet has started nothing for ${streak.cycles} cycles running, with ${n} ` +
        `candidate${n === 1 ? '' : 's'} above the cut-line and room under the cap.`,
      detail: [
        `stalled since ${streak.since}`,
        `up next: ${cycle.dispatching.join(', ')}`,
        refusal === null ? 'no dispatch was attempted' : `last refusal: ${refusal}`,
      ].join('\n'),
    });
  }

  reading(): FleetStall | null {
    return this.current;
  }
}
