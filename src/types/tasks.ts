type TaskKind = 'code' | 'desk';

type TaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'interrupted' | 'failed';

export interface TaskSummary {
  id: string;
  kind: TaskKind;
  title: string;
  branch: string | null;
  originRef: string | null;
  originTitle: string | null;
  originSummary: string | null;
  dispatchReason: string | null;
  rule?: string | null;
  ciChecks?: string[] | null;
  mcpServers?: ExtraMcpServer[] | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  permissionAutoApprove?: boolean | null;
  profile?: string | null;
  profileSource?: string | null;
  status: TaskStatus;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task extends TaskSummary {
  prompt: string;
}

type JobStatus = 'queued' | 'dispatched' | 'cancelled';

export interface Job {
  id: string;
  title: string;
  prompt: string;
  kind: TaskKind;
  branch: string | null;
  status: JobStatus;
  originRef: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobSchedule {
  id: string;
  title: string;
  prompt: string;
  kind: TaskKind;
  cron: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobAttachmentInput {
  name?: string;
  data: string;
}

export interface JobAttachment {
  id: string;
  targetRef: string;
  index: number;
  label: string;
  mime: string;
  bytes: number;
  path: string;
  createdAt: string;
}

export interface ExtraMcpServer {
  key: string;
  command: string;
  args: string[];
}
