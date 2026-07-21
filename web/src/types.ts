// Mirrors the server's domain types (kept deliberately small — just what the UI renders).

export interface PrComment {
  id: string;
  author: string;
  body: string;
  handled: boolean;
}
export interface PullRequest {
  id: string;
  number: number;
  title: string;
  branch: string;
  ciStatus: string;
  unresolvedComments: PrComment[];
  approved?: boolean;
  mergeable?: boolean;
  baseBranch?: string;
  mergeableState?: string;
  merged?: boolean;
  /** Server-computed health: why the PR is stuck (empty reasons = healthy). */
  health?: { blocked: boolean; reasons: string[] };
}
export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  linkedPrNumber: number | null;
}
export interface Story {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  wafPillars: string[];
  state: string;
  priority: number;
}
export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  prepDocs: string[];
  prepDone: boolean;
}
export interface WorldSnapshot {
  takenAt: string;
  pullRequests: PullRequest[];
  issues: Issue[];
  stories: Story[];
  calendar: CalendarEvent[];
}

export interface Task {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  branch: string | null;
  originRef: string | null;
  status: string;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Agent {
  id: string;
  taskId: string;
  status: string;
  cwd: string;
  pid: number | null;
  waitingReason: string | null;
  startedAt: string;
  endedAt: string | null;
}
export interface Escalation {
  id: string;
  type: string;
  status: string;
  prompt: string;
  context: Record<string, unknown>;
  agentId: string | null;
  taskId: string | null;
  response: string | null;
  createdAt: string;
  answeredAt: string | null;
}
export interface Decision {
  id: string;
  cycleId: string;
  action: { type: string; reason?: string };
  outcome: string;
  detail: string;
  createdAt: string;
}

export interface AppState {
  config: {
    heartbeatIntervalMs: number;
    maxConcurrentAgents: number;
    dispatcher: string;
    steeringPriorities: string[];
  };
  world: WorldSnapshot;
  tasks: Task[];
  agents: Agent[];
  escalations: Escalation[];
  decisions: Decision[];
}

export type ServerEvent =
  | { type: 'dirty' }
  | { type: 'agent:output'; agentId: string; delta: string }
  | { type: 'agent:waiting'; agentId: string; taskId: string; reason: string }
  | { type: 'cycle:end'; cycleId: string; rationale: string }
  | { type: string; [k: string]: unknown };
