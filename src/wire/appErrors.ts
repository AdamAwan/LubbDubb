import type {
  AppErrorGroup,
  AppErrorLink,
  AppErrorRead,
  AppErrorReadStatus,
  AppErrorSpike,
  AppErrorState,
  AppErrorTicketSearch,
  AppErrorTracker,
  DeployedHead,
} from '../types.js';

/** → docs/spec/39-app-errors.md#on-the-wire */
export interface AppErrorGroupView extends AppErrorGroup {
  key: string;
  state: AppErrorState;
  count: number;
  ignored: boolean;
  /** The rates behind a `spiking` state; null in every other state. */
  spike: AppErrorSpike | null;
  link: AppErrorLink | null;
  tracker: AppErrorTracker | null;
}

export interface AppErrorEnvironmentView {
  environment: string;
  band: string;
  reading: AppErrorRead | null;
  head: DeployedHead | null;
  groups: AppErrorGroupView[];
}

export interface AppErrorBandGroup {
  key: string;
  fingerprint: string;
  title: string;
  state: AppErrorState;
  environments: string[];
  count: number;
  lastSeen: string;
}

export interface AppErrorBandView {
  band: string;
  declared: boolean;
  environments: string[];
  status: AppErrorReadStatus | null;
  groups: AppErrorBandGroup[];
}

export interface AppErrorsPayload {
  project: string;
  environments: AppErrorEnvironmentView[];
  bands: AppErrorBandView[];
}

/** What a press on an Errors row answered: the ticket that now answers for the key, and whether it was already there. */
export interface AppErrorPressPayload {
  ok: true;
  ticketRef: string;
  reused: boolean;
  /** For Investigate: the label writes that failed, each a sentence. Null for any other press. */
  investigation: { failed: string[] } | null;
}

export interface AppErrorSearchPayload {
  ok: true;
  search: AppErrorTicketSearch;
}
