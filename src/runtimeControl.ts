// → docs/spec/09-execution.md#exhaustion

export interface ControlState {
  cap: number;
  paused: boolean;
}

interface ControlPatch {
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
