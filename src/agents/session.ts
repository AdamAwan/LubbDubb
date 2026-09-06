import type { EventEmitter } from 'node:events';

// → docs/spec/10-agent-runtimes.md

export type AgentSessionStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'failed';

export interface AgentSession extends EventEmitter {
  readonly status: AgentSessionStatus;
  readonly pid: number | null;
  start(): void;
  send(text: string): void;
  readonly recordsSentMessages?: boolean;
  sendRaw(data: string): void;
  kill(signal?: string): void;
}

export interface AgentSessionSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  waitingPatterns?: string[];
  sessionId?: string | null;
  resume?: boolean;
}

export type SessionFactory = (spec: AgentSessionSpec) => AgentSession;
