export type WorkNodeKind = 'issue' | 'plan' | 'part' | 'pr' | 'concern' | 'job' | 'assess';

export type WorkNodeProvenance = 'observed' | 'inferred';

export interface WorkNode {
  ref: string;
  kind: WorkNodeKind;
  parentRef: string | null;
  baseRef: string | null;
  title: string;
  status: string;
  terminal: boolean;
  provenance: WorkNodeProvenance | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type WorkItemFilingStatus = 'filing' | 'filed';

export interface WorkItemFiling {
  targetRef: string;
  status: WorkItemFilingStatus;
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BugFiling {
  jobId: string;
  originRef: string;
  status: WorkItemFilingStatus;
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkNodeObservation {
  ref: string;
  kind: WorkNodeKind;
  parentRef?: string | null;
  baseRef?: string | null;
  title: string;
  status: string;
  terminal: boolean;
  provenance?: WorkNodeProvenance | null;
}
