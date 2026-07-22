/**
 * Live, in-memory dispatch controls — the concurrency cap, a pause flag, and the
 * set of PRs to leave alone — that the {@link Harness} and {@link ActionExecutor}
 * read **by reference** each cycle. Seeded from `config.maxConcurrentAgents`/
 * `config.startPaused`/`config.excludedPrs` at boot and mutated at runtime via the
 * control endpoint; deliberately **not persisted**, so a restart reverts to the
 * configured defaults.
 */
export interface ControlState {
  /** Hard cap on concurrently-running agents. */
  cap: number;
  /** While true, no new agents are dispatched; live agents keep running. */
  paused: boolean;
  /** PR numbers the dispatcher ignores this cycle (sorted for a stable snapshot). */
  excludedPrs: number[];
}

/** A partial change to apply — omit a field to leave it untouched. */
export interface ControlPatch {
  cap?: number;
  paused?: boolean;
  /** Replaces the exclusion set wholesale (the endpoint sends the full desired list). */
  excludedPrs?: number[];
}

export class RuntimeControl {
  private cap_: number;
  private paused_: boolean;
  /** Held as a Set so the harness can do O(1) `has` checks each cycle. */
  private excluded: Set<number>;

  constructor(cap: number, paused: boolean, excludedPrs: number[] = []) {
    this.cap_ = cap;
    this.paused_ = paused;
    this.excluded = new Set(excludedPrs);
  }

  get cap(): number {
    return this.cap_;
  }

  get paused(): boolean {
    return this.paused_;
  }

  /**
   * The live exclusion set, returned by reference so a caller reading it each
   * cycle sees runtime changes (never copy it into a local at wiring time).
   */
  get excludedPrs(): ReadonlySet<number> {
    return this.excluded;
  }

  snapshot(): ControlState {
    return { cap: this.cap_, paused: this.paused_, excludedPrs: [...this.excluded].sort((a, b) => a - b) };
  }

  /**
   * Validate and apply a patch, returning the resulting state. Validation lives
   * here so the endpoint and tests share one source of truth. Throws (leaving
   * state untouched) if `cap` is not a non-negative integer or `excludedPrs`
   * contains anything but non-negative integers.
   */
  apply(patch: ControlPatch): ControlState {
    if (patch.cap !== undefined) {
      if (!Number.isInteger(patch.cap) || patch.cap < 0) {
        throw new Error(`cap must be a non-negative integer, got ${patch.cap}`);
      }
    }
    if (patch.excludedPrs !== undefined) {
      for (const n of patch.excludedPrs) {
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`excludedPrs must be non-negative integers, got ${n}`);
        }
      }
    }
    // All validation passed — mutate only now, so a bad field leaves state intact.
    if (patch.cap !== undefined) this.cap_ = patch.cap;
    if (patch.paused !== undefined) this.paused_ = patch.paused;
    if (patch.excludedPrs !== undefined) this.excluded = new Set(patch.excludedPrs);
    return this.snapshot();
  }
}
