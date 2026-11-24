/** → docs/spec/39-app-errors.md */
export type AppErrorReadStatus = 'ok' | 'unknown';

export type AppErrorState = 'new' | 'returned' | 'spiking' | 'steady' | 'gone';

/** What one environment's `errors` command last said. */
export interface AppErrorRead {
  environment: string;
  status: AppErrorReadStatus;
  detail: string | null;
  readAt: string;
  okAt: string | null;
  /** The query the last answered read ran, as the command printed it; null when it printed none. */
  query: string | null;
  /** A link that opens that query in the telemetry's own portal, absolute http(s); null when none was printed. */
  queryLink: string | null;
}

export interface AppErrorDay {
  day: string;
  count: number;
}

/** A sample occurrence's message and stack: drawn on the Errors tab when opened, and sent nowhere else. */
export interface AppErrorDetail {
  message: string | null;
  stack: string | null;
}

/** One fingerprint on one environment, as the harness has accumulated it across reads. */
export interface AppErrorGroup {
  environment: string;
  fingerprint: string;
  title: string;
  operation: string | null;
  version: string | null;
  frames: string[];
  hasDetail: boolean;
  url: string | null;
  firstSeen: string;
  lastSeen: string;
  returnedAt: string | null;
  daily: AppErrorDay[];
}

/** The two daily rates a `spiking` group was read off: since the deploy's day, and the baseline before it, floored at one. */
export interface AppErrorSpike {
  perDay: number;
  baselinePerDay: number;
}

/** What made a link: the group's frames in a goal's landed diff, its first sighting on another environment, its operation. */
export type AppErrorLinkHow = 'frame-match' | 'test-arrival' | 'route-hint';

/** Which goal an error group is probably the work of, and how that was decided. → docs/spec/39-app-errors.md#linking-a-group-to-work */
export interface AppErrorLink {
  /** Null when the evidence did not single out one goal — `why` says what it did find. */
  goalRef: string | null;
  how: AppErrorLinkHow[];
  why: string;
  /** How many goals the window held; null when the window could not be decided. */
  candidates: number | null;
  /** The goals the evidence narrowed to and could not choose between; empty otherwise. */
  tied: string[];
}

export type AppErrorTrackerStatus = 'none' | 'open' | 'closed' | 'unknown';

/** What the tracker holds under an error group's key, as the Errors tab draws it. */
export interface AppErrorTracker {
  status: AppErrorTrackerStatus;
  ticketRef: string | null;
  note: string | null;
}

/** → docs/spec/39-app-errors.md#agent-triage */
export type AppErrorTriageVerdict = 'caused-by' | 'pre-existing' | 'unclear';

export type AppErrorTriageConfidence = 'low' | 'medium' | 'high';

export type AppErrorTriageTrigger = 'auto' | 'operator';

export type AppErrorTriageRunStatus = 'pending' | 'dispatched' | 'done';

/**
 * One moved group's episode put in front of the triage agent: the group, the state it moved into, the
 * instant that episode is anchored at (empty for a spike with no deploy on record), and the goals it may
 * name as the cause.
 */
export interface AppErrorTriageSubject {
  key: string;
  environment: string;
  fingerprint: string;
  state: AppErrorState;
  anchor: string;
  candidates: string[];
}

export interface AppErrorTriageRun {
  id: string;
  status: AppErrorTriageRunStatus;
  trigger: AppErrorTriageTrigger;
  subjects: AppErrorTriageSubject[];
  taskId: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** A run waiting for its agent carries the briefing it is dispatched with, assembled when it opened. */
export interface PendingAppErrorTriageRun extends AppErrorTriageRun {
  briefing: string;
}

/**
 * What the triage agent said about a group's current episode, as the Errors tab draws it. Every verdict
 * field is null while the episode sits in a run nobody has answered for yet (`queued`).
 */
export interface AppErrorTriage {
  verdict: AppErrorTriageVerdict | null;
  goalRef: string | null;
  confidence: AppErrorTriageConfidence | null;
  reason: string | null;
  at: string | null;
  queued: boolean;
  /** When the triage agent last asked for this episode's stored message and stack; null when it never did. */
  detailReadAt: string | null;
  /** When that ask last ran the environment's `errors.detail` query, and whether it answered; null when none did. */
  detailQuery: AppErrorDetailQueryRun | null;
}

/** One run of an environment's detail query by the triage agent: when, and whether it printed an answer. */
export interface AppErrorDetailQueryRun {
  at: string;
  ok: boolean;
}

/** What the last search for one key found: the ticket that answers for it, and how many carried it. */
export interface AppErrorTicketSearch {
  key: string;
  status: AppErrorTrackerStatus;
  ticketRef: string | null;
  closedAt: string | null;
  tickets: number;
  detail: string | null;
  checkedAt: string;
}

/** The goal a moved error is put on, and whether by its link or only by the triage agent's guess. */
export interface AppErrorOnGoal {
  goalRef: string;
  basis: 'linked' | 'guess';
}

/** An operator's "Not it": the error under `key` was not caused by `goalRef`. → docs/spec/39-app-errors.md#not-it */
export interface AppErrorDismissal {
  key: string;
  goalRef: string;
  at: string;
}
