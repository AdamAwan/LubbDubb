import type { UnrecordedWork } from '../graph/unrecorded.js';
import type { Agent, AgentFile, TaskSummary, WorkNode } from '../types.js';

export interface AgentTranscript {
  agentId: string;
  from: number;
  total: number;
  transcript: string;
}

export interface AgentFilesPayload {
  agentId: string;
  files: AgentFile[];
}

export interface GoalAgentsPayload {
  ref: string;
  agents: Agent[];
  tasks: readonly TaskSummary[];
}

export interface WorkRootsPayload {
  roots: WorkNode[];
  unrecorded: UnrecordedWork[];
  refUrls: Record<string, string>;
}

export interface WorkSubtreePayload {
  nodes: WorkNode[];
  refUrls: Record<string, string>;
}
