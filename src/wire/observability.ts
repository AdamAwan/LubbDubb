import type { ErrorLogEntry } from '../types.js';

// → docs/spec/18-observability.md#reporting-a-fault-to-lubbdubb

export interface FaultReport {
  fingerprint: string;
  source: ErrorLogEntry['source'];
  count: number;
  title: string;
  body: string;
  issueUrl: string | null;
  withheld: string | null;
}

export interface FaultReports {
  reports: FaultReport[];
  unavailable: string | null;
}
