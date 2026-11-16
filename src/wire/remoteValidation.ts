import type {
  OkScope,
  OkStanding,
  RemoteReading,
  RemoteRun,
  RemoteRunIntent,
  RemoteSheet,
  RemoteSheetRow,
  TenantPreparation,
  TenantStanding,
} from '../types.js';

/**
 * One goal's sheet against one environment, with every row's reading folded in on the server. The
 * cockpit renders what the server read; it never re-decides an outcome.
 */
export interface RemoteSheetView extends RemoteSheet {
  rows: RemoteSheetRowView[];
  /** The latest run against this environment, live or ended. Null before anything was ever pressed. */
  run: RemoteRunView | null;
  /** The operator's OK to run it, and what became of it. Null before one was ever given. */
  intent: RemoteRunIntent | null;
  /** What an OK would run — all zero, and the page asks for nothing. */
  okable: OkScope;
  /** Where the page stands, worked out on the server — the same reading the `validate` row holds on. */
  ok: OkStanding;
  /** Which tenant this sheet is put to, how old it is, and why there is none. */
  tenant: RemoteTenantView;
}

export interface RemoteRunView extends RemoteRun {
  /**
   * Where the run's video can be watched, keyed on the run alone. The run carries the recording's
   * **name**; minting a URL is the server's job. Null where the run recorded nothing.
   * → docs/spec/36-remote-validation.md#the-runs-recording
   */
  recordingUrl: string | null;
}

/**
 * What the gate draws about a tenant. It carries the name a surface may draw — a literal `tenant`,
 * or the *variable's* own name where the shape is `tenantEnv` — and never a `tenantEnv`'s value,
 * which goes into the spawn env and nowhere else.
 */
export interface RemoteTenantView extends TenantStanding {
  /** Whether the environment declares an `ensureTenant` or a `reseed` for the gate's own control. */
  reseedable: boolean;
  /**
   * Whether pressing that control runs a `reseed` — a command that destroys the tenant's data. An
   * environment declaring only `ensureTenant` provisions and destroys nothing, so the gate must not
   * warn about a wipe that will not happen.
   */
  destructive: boolean;
  /**
   * The preparation running right now, or the last one that ran. Null before anything was ever
   * pressed. `finishedAt` null is **still running** — which is what an operator who pressed a command
   * that takes tens of minutes has otherwise no way to learn.
   */
  preparation: TenantPreparation | null;
}

/**
 * One environment's tenant commands as configured, and its preparation — running now, or the last one
 * that ran. The commands are the committed project config's own text; the tenant a `tenantEnv` names
 * is never here.
 */
export interface TenantCommandView {
  environment: string;
  ensureTenant: string | null;
  reseed: string | null;
  preparation: TenantPreparation | null;
}

/** The tail of a tenant command's output, stdout and stderr together. */
export interface TenantCommandOutput {
  lines: string[];
  /** When the command last wrote anything — what tells a stalled command from a busy one. */
  lastOutputAt: string | null;
}

export interface RemoteSheetRowView extends RemoteSheetRow {
  /** The latest reading on this row, or null where none was taken — a blocked row, or a manual one. */
  reading: RemoteReadingView | null;
}

/**
 * A reading, with the way to the agent that produced it. The chain is `runId` → `RemoteRun.taskId` →
 * `tasks.agentId`, walked on the server: the cockpit is handed the agent's own id because that is
 * what opens a transcript, and a surface that had to walk two stores to draw a link would be a second
 * copy of the join. Both are null on a reading no run took — the press's own deterministic rows — and
 * on one whose run never got an agent.
 * → docs/spec/36-remote-validation.md#the-reading-an-agent-produced
 */
export interface RemoteReadingView extends RemoteReading {
  /** The task the run was dispatched as. */
  taskId: string | null;
  /** The agent that ran it, which is the transcript's own key — `GET /api/agents/:id/transcript`. */
  agentId: string | null;
  /**
   * Where this row's own capture can be looked at, keyed on the run and the row. The row carries the
   * capture's **name**; minting a URL is the server's job, `ValidationCheckView.captureUrl`'s reason.
   * Null where the row handed back no screen — and on a reading no run took, which can hand none back.
   * → docs/spec/36-remote-validation.md#where-a-sheet-kept-capture-is-looked-at
   */
  captureUrl: string | null;
}
