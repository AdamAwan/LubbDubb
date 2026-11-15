import type { FilingTarget } from '../sink/actionSink.js';
import type { IssueState } from '../types.js';

export type TicketWatchFilter = 'any' | 'watched' | 'unwatched';

export type TicketTrackingFilter = 'any' | 'live' | 'frozen';

export type TicketStateFilter = string;

export type TicketOrder = 'added' | 'changed' | 'cost';

export interface TicketStateFacet {
  state: string;
  count: number;
  live: number;
  pickup: boolean;
}

export interface TicketFeatureFacet {
  number: number;
  title: string;
  slot: number;
  count: number;
}

export interface TicketRow {
  number: number;
  title: string;
  state: IssueState;
  watch: TicketWatchFilter & ('watched' | 'unwatched');
  labels: string[];
  costUsd: number | null;
  outcome: string | null;
  addedAt: string;
  changedAt: string;
  tracking: 'live' | 'frozen';
  workItemState: string | null;
  issueType: string | null;
  parent?: { number: number; title: string } | null;
  featureSlot: number | null;
}

export type FilingTargetProbe =
  | ({
      available: true;
      reason: null;
      watchable: boolean;
    } & FilingTarget)
  | {
      available: false;
      target: null;
      identity: null;
      reason: string;
    };

export interface IssueFiled {
  ok: true;
  number: number;
  url: string;
}

export interface TicketsPayload {
  rows: TicketRow[];
  total: number;
  kept: number;
  totalCostUsd: number;
  nextCursor: string | null;
  anchorAt: string;
  backfilling: boolean;
  live: number;
  states: TicketStateFacet[];
  features: TicketFeatureFacet[];
  orphanCount: number;
  refUrls: Record<string, string>;
}
