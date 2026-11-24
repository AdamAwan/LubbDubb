import type {
  AppErrorGroup,
  AppErrorLink,
  AppErrorRead,
  AppErrorReadStatus,
  AppErrorSpike,
  AppErrorState,
  AppErrorTicketSearch,
  AppErrorTracker,
  AppErrorTriage,
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
  /** The triage agent's word on this episode, kept apart from the deterministic `link`. */
  triage: AppErrorTriage | null;
  /** The goals an operator said this error is not from ("Not it"); neither its link nor a guess counts on them. */
  dismissed: string[];
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

/** What a Triage press opened: the run that holds the group. */
export interface AppErrorTriagePressPayload {
  ok: true;
  runId: string;
}

export interface AppErrorSearchPayload {
  ok: true;
  search: AppErrorTicketSearch;
}

/** What a "Not it" stored: the goal the error is no longer counted on, as the harness spells it. */
export interface AppErrorDismissPayload {
  ok: true;
  goalRef: string;
}
