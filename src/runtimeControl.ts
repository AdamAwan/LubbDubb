/**
 * Live, in-memory dispatch controls — the concurrency cap and a pause flag —
 * that the {@link Harness} and {@link ActionExecutor} read **by reference** each
 * cycle. Seeded from `config.maxConcurrentAgents`/`config.startPaused` at boot and
 * mutated at runtime via the control endpoint; deliberately **not persisted**, so
 * a restart reverts to the configured defaults.
 */
export interface ControlState {
  /** Hard cap on concurrently-running agents. */
  cap: number;
  /** While true, no new agents are dispatched; live agents keep running. */
  paused: boolean;
}

/** A partial change to apply — omit a field to leave it untouched. */
export interface ControlPatch {
  cap?: number;
  paused?: boolean;
}

export class RuntimeControl {
  private state: ControlState;

  constructor(cap: number, paused: boolean) {
    this.state = { cap, paused };
  }

  get cap(): number {
    return this.state.cap;
  }

  get paused(): boolean {
    return this.state.paused;
  }

  snapshot(): ControlState {
    return { ...this.state };
  }

  /**
   * Validate and apply a patch, returning the resulting state. Validation lives
   * here so the endpoint and tests share one source of truth. Throws (leaving
   * state untouched) if `cap` is not a non-negative integer.
   */
  apply(patch: ControlPatch): ControlState {
    if (patch.cap !== undefined) {
      if (!Number.isInteger(patch.cap) || patch.cap < 0) {
        throw new Error(`cap must be a non-negative integer, got ${patch.cap}`);
      }
    }
    if (patch.cap !== undefined) this.state.cap = patch.cap;
    if (patch.paused !== undefined) this.state.paused = patch.paused;
    return this.snapshot();
  }
}
