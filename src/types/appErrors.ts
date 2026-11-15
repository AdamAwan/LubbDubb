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
