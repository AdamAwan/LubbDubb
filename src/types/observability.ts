import type { PlaceKey, UsageArrival, UsageSubject, UsageVerb } from '../usage/events.js';

export interface ErrorLogEntry {
  id: string;
  source: 'cycle' | 'provider' | 'agent' | 'server' | 'boot' | 'runtime';
  message: string;
  detail: string | null;
  createdAt: string;
}

export type ErrorLogInput = Omit<ErrorLogEntry, 'id' | 'createdAt' | 'detail'> & { detail?: string | null };

/** One window of event-loop delay, in milliseconds. → docs/spec/18-observability.md#the-runtime-watch */
export interface EventLoopWindow {
  at: string;
  windowMs: number;
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface SlowRead {
  sql: string;
  count: number;
  maxMs: number;
  lastAt: string;
}

export interface RuntimeHealthReading {
  /** Null until the first window closes. */
  eventLoop: EventLoopWindow | null;
  /** Statements that have crossed the slow-read threshold since boot, most recent first. */
  slowReads: SlowRead[];
}

export type McpChannel = 'fleet' | 'desktop';

export interface McpCall {
  id: string;
  channel: McpChannel;
  tool: string;
  agentId: string | null;
  taskId: string | null;
  originRef: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
  args: string | null;
  argsBytes: number;
  argsDropped: boolean;
  createdAt: string;
}

export type ApiErrorKind = 'safeguards' | 'other';

export interface ApiErrorReading {
  kind: ApiErrorKind;
  code: string | null;
  message: string;
}

export interface ApiErrorEvent extends ApiErrorReading {
  id: string;
  agentId: string;
  taskId: string;
  originRef: string | null;
  model: string | null;
  createdAt: string;
}

export interface McpCallInput {
  channel: McpChannel;
  tool: string;
  agentId: string | null;
  taskId: string | null;
  originRef: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
  args: Record<string, unknown>;
}

export interface SurfaceReach {
  subject: UsageSubject;
  verb: UsageVerb;
  place: PlaceKey;
  at: string;
  arrival: UsageArrival;
}

export type SurfaceReachInput = Omit<SurfaceReach, 'at'>;
