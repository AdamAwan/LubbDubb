import type { ExtraMcpServer } from './tasks.js';
import type { WatchReadingVerdict } from './watch.js';

/**
 * Why a validating environment holds no sheet for a goal, and whether an operator can set one up by
 * hand. → docs/spec/36-remote-validation.md#when-there-is-no-sheet
 */
export interface NoSheet {
  why: string;
  setUp: boolean;
}

export type StateQueryAuthor = 'plan' | 'agent' | 'operator';

export interface StateQueryInput {
  id: string;
  seq: number;
  title: string;
  query: string;
  presence: string;
  why: string | null;
}

export interface StateQuery extends StateQueryInput {
  originRef: string;
  digest: string;
  authored: StateQueryAuthor;
  dryRunEnvironment: string | null;
  dryRunAt: string | null;
  dryRunVerdict: WatchReadingVerdict | null;
  dryRunPresence: WatchReadingVerdict | null;
  dryRunRows: number | null;
  dryRunDetail: string | null;
  dryRunSample: string | null;
}

export type RemoteRowKind = 'check' | 'state';

/**
 * What a sheet row came back as. **`captured` is not a synonym for either end of the other three**:
 * a `screenshot` step asserts nothing, so the row holds a screen somebody still has to look at, and
 * a person's reading is what turns it into a pass or a failure.
 * → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
 */
export type RemoteRowOutcome = 'passed' | 'failed' | 'blocked' | 'captured';

/** One goal's checks, watches and state queries, assembled against one environment. */
export interface RemoteSheet {
  goalRef: string;
  environment: string;
  assembledAt: string;
}

export interface RemoteSheetRow {
  goalRef: string;
  environment: string;
  rowId: string;
  kind: RemoteRowKind;
  seq: number;
  title: string;
  sourceId: string;
  selected: boolean;
  /** Non-null means no reading was taken, and this is what an operator is told instead. */
  blockedReason: string | null;
  awaitingApproval: boolean;
  /**
   * How many tests the runner's own listing attributes to this row's area, taken by the run agent in
   * its pinned checkout. **Null means the listing has not been taken for this row yet** — never a
   * selector that matched nothing — and it is never derived from a report: derived that way, a
   * selector matching nothing reads as a clean pass.
   */
  matched: number | null;
  /**
   * Why a press reads nothing here and dispatches for nothing, in words. Null is a row the press
   * reads or an agent is sent for. It is **not** a `blockedReason`: a block is a cause no press can
   * overcome, and most checks on most deployments are a person's journey end to end, which is the
   * ordinary answer rather than a misconfiguration. It is folded on the server, beside the row it
   * describes, because a cockpit that worked out for itself which rows a press would touch would be
   * a second opinion drawn beside the reading.
   * → docs/spec/36-remote-validation.md#a-row-no-press-can-read
   */
  idleReason: string | null;
}

/**
 * A point-in-time answer on one sheet row. Never a `WorldEvent` and never a `watch_readings` row —
 * see 36-remote-validation.md.
 */
export interface RemoteReading {
  goalRef: string;
  environment: string;
  rowId: string;
  runId: string | null;
  outcome: RemoteRowOutcome;
  rows: number | null;
  value: number | null;
  detail: string | null;
  /** The commits the run this reading came through straddled. Both null on one taken at assembly. */
  startedSha: string | null;
  endedSha: string | null;
  /**
   * What the run's own report said about this row: how many of the matched tests actually ran, how
   * many retries it took, and how long it stood there. Null on a deterministic row, which is a
   * query rather than a suite. **`matched` is not here** — it is on the sheet row, written by the
   * pre-flight's listing, because derived from a report a selector that matched nothing reads as a
   * clean pass.
   */
  executed: number | null;
  retries: number | null;
  durationMs: number | null;
  /** The URL the publish command printed, which is what makes a red row actionable in thirty seconds. */
  artefacts: string | null;
  /**
   * The screen this row handed back, as a **file name** in the goal's validation directory — the
   * check row's `capture` rule, for the check row's reason. It is written whether or not the run went
   * on to write the check row, because a run that declined to overwrite somebody else's reading still
   * took the picture and somebody still has to look at it.
   * → docs/spec/36-remote-validation.md#where-a-sheet-kept-capture-is-looked-at
   */
  capture: string | null;
  readAt: string;
}

/**
 * That a sheet-kept capture has been posted to the goal's ticket. The row **is** the idempotence —
 * nothing about a tracker comment can be read back to find out whether it went, and a screen posted
 * twice on a re-read is worse than one never posted.
 * → docs/spec/36-remote-validation.md#where-a-sheet-kept-capture-is-looked-at
 */
export interface RemoteCapturePost {
  runId: string;
  rowId: string;
  goalRef: string;
  capture: string;
  postedAt: string;
}

/**
 * A press opens a run `pending`; the dispatch flip claims it `dispatched`, conditionally and inside
 * the transaction, which is what makes one agent per run true across a restart. Both are *live* and
 * the `(environment, tenant)` lock holds over both. A run settles once: `ended` where a report was
 * recorded against it, `abandoned` where none ever will be — the pin refused it, an operator called
 * it off, or the agent handed it back.
 */
export type RemoteRunStatus = 'pending' | 'dispatched' | 'ended' | 'abandoned';

/**
 * One press. Kept after it ends, `local_validations`' rule: a run abandoned because the environment
 * went back past the goal's work is the case an operator actually hits, and its reason has to be
 * readable afterwards.
 *
 * `tenant` is the *key* the lock is enforced on and never a `tenantEnv`'s value — see
 * 36-remote-validation.md#tenants.
 */
export type RemoteRunIntentState = 'given' | 'withdrawn' | 'consumed' | 'not_here';

/**
 * An operator's OK to run one goal's sheet on one environment. → docs/spec/36-remote-validation.md#the-ok
 */
export interface RemoteRunIntent {
  goalRef: string;
  environment: string;
  state: RemoteRunIntentState;
  /** What the OK was given over. Empty on a row written for a sheet from before the OK existed. */
  fingerprint: string;
  givenAt: string;
  /** The run a consumed intent opened. */
  runId: string | null;
  /** Why a given intent has not been pressed yet, or the operator's reason for not validating here. */
  note: string | null;
  updatedAt: string;
}

/**
 * Where one environment's validation page stands, worked out once on the server and read by both the
 * cockpit and the `validate` row's hold. → docs/spec/36-remote-validation.md#the-ok
 */
export type OkStatus = 'needs-you' | 'queued' | 'running' | 'done' | 'not-here' | 'open' | 'nothing';

export interface OkStanding {
  status: OkStatus;
  /** Why it stands there, where a sentence says more than the status: the run's abandon reason, the queue. */
  why: string | null;
}

export interface RemoteRun {
  id: string;
  goalRef: string;
  environment: string;
  tenant: string;
  status: RemoteRunStatus;
  startedSha: string | null;
  endedSha: string | null;
  startedAt: string;
  endedAt: string | null;
  note: string | null;
  /** The dispatched agent's task, written by the same conditional flip that claimed the run. */
  taskId: string | null;
  /** Where the agent said the runner's machine-readable report landed. Parsing it is another part. */
  reportPath: string | null;
  /**
   * Where the agent said the runner's own selector listing landed. A path, never what is in it —
   * the denominator is parsed out of that file and is never a thing an agent states.
   */
  listingPath: string | null;
  /** The URL the publish command printed, where it ran. */
  artefacts: string | null;
  /** The video the run recorded: a file name in the goal's validation directory, never a path. */
  recording: string | null;
}

/**
 * One open run, with everything the dispatcher needs to put an agent on it already rendered. The
 * rule reads these and imports nothing from `src/validation/remote/` or `src/environments/` — the
 * arrangement `testPartNote` and `stateDeclareNote` already make for their prompts.
 */
export interface RemoteRunBrief {
  runId: string;
  goalRef: string;
  issueNumber: number;
  environment: string;
  status: RemoteRunStatus;
  /** `issue:<n>:validate-remote:<runId>` — evidence about delivered work, never work. */
  origin: string;
  /** The lease key the read-only checkout is taken under. No ref is minted. */
  leaseKey: string;
  /** The commit the environment stood at when the pin was taken. The checkout is pinned to it. */
  deployedSha: string;
  /** How many `check` rows this run is for. Zero is a run no agent is dispatched for. */
  confirmed: number;
  /**
   * The browser MCP server the run's agent drives, with this run's own directories substituted, or
   * null where the deployment has configured none. It is folded here rather than in the rule because
   * `src/validation/remote/` is a lens as far as the dispatcher is concerned.
   * → docs/spec/36-remote-validation.md#the-browser-the-run-drives
   */
  browser: ExtraMcpServer | null;
  /** Everything the agent must read, already rendered — appended to the prompt, never interpolated. */
  briefing: string;
}

/** When an environment's tenant was last provisioned and last reseeded. */
/**
 * The tenant preparation running right now against an environment, or the last one that ran. One row
 * per environment, because the commands are slow enough — tens of minutes — that an operator who
 * pressed and saw nothing cannot tell a job still running from one that died.
 *
 * `finishedAt` null is **still running**. `ok` is three-valued and the third value is load bearing:
 * null on a finished row is *the harness restarted while this was going*, which is not a failure and
 * not a success — the command outlived this process and what it did is not knowable from here.
 * → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs
 */
/** Which of an environment's two tenant commands. */
export type TenantCall = 'ensure' | 'reseed';

/**
 * One launch of a tenant command: what a later process needs to find it again. `id` names the
 * harness-owned directory its output is teed into; `pid` is the runner holding the command.
 */
export interface TenantLaunch {
  id: string;
  pid: number | null;
  startedAt: string;
}

export interface TenantPreparation {
  environment: string;
  /** The name the commands settled on. Null while it runs, and on an `ensureTenant` that named none. */
  tenant: string | null;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  detail: string | null;
  /** The command running now, or the last one this preparation ran. Null before one has launched. */
  call: TenantCall | null;
  /** When that command was launched. */
  launchedAt: string | null;
}

export interface RemoteTenant {
  environment: string;
  tenant: string;
  ensuredAt: string | null;
  reseededAt: string | null;
}

/**
 * What the lock, the sheet and the gate know about an environment's tenant. It carries the name a
 * surface may draw and **never** a `tenantEnv`'s value, which goes into the spawn env and nowhere
 * else. `stale` is a qualifier on a reading and never a fourth outcome.
 */
export interface TenantStanding {
  /** The lock's key, and what a surface draws. Null where no shape supplied one. */
  tenant: string | null;
  reseededAt: string | null;
  ageMs: number | null;
  freshnessMs: number | null;
  stale: boolean;
  /** Why there is no tenant, naming the command or the variable that would provide one. */
  blockedReason: string | null;
}

/** One operator's "I have read this, and it is safe *here*" — see 36-remote-validation.md. */
export interface StateQueryApproval {
  digest: string;
  environment: string;
  originRef: string;
  queryId: string;
  approvedAt: string;
  rows: number | null;
  detail: string | null;
}
