import type { LocalRunOption } from '../localRun/ref.js';
import type {
  AgentStatus,
  CiStatus,
  LocalRun,
  LocalRunFreshness,
  LocalRunPorts,
  LocalRunTurn,
  LocalValidation,
  ValidationMediaKind,
  PlanPart,
  PrState,
} from '../types.js';

export interface LocalRunRefFacts {
  ref: string;
  isDefaultBranch: boolean;
  part: { slug: string; title: string; seq: number; total: number; status: PlanPart['status'] } | null;
  pr: {
    number: number;
    state: PrState;
    ciStatus: CiStatus;
    failing: string[];
    approved: boolean;
    unresolved: number;
  } | null;
  mergedParts: number;
  agentOnIt: boolean;
  lastActivityAt: string | null;
}

export type LocalValidationPhase = 'queued' | 'planning' | 'environment' | 'driving';

interface LocalValidationFile {
  name: string;
  url: string;
  kind: ValidationMediaKind;
}

export interface LocalValidationAgentView {
  id: string;
  status: AgentStatus;
}

export interface LocalValidationView extends LocalValidation {
  phase: LocalValidationPhase | null;
  files: LocalValidationFile[];
  agent: LocalValidationAgentView | null;
  fixAgent: LocalValidationAgentView | null;
}

export interface LocalRunTargetView {
  originRef: string;
  issueNumber: number;
  target: LocalRunRefFacts;
  options: { option: LocalRunOption; facts: LocalRunRefFacts }[];
  runnable: boolean;
}

export interface LocalRunView extends LocalRun {
  live: boolean;
  refFacts: LocalRunRefFacts | null;
  phase: string | null;
  turn: LocalRunTurn | null;
  holdsSession: boolean;
  ports: LocalRunPorts | null;
  freshness: LocalRunFreshness | null;
}
