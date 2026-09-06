import { nanoid } from 'nanoid';
import type { McpCall, McpCallInput } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class McpCallStore {
  private lastCompactedAt: number | null = null;

  constructor(private readonly ctx: StoreContext) {}

  recordMcpCall(input: McpCallInput, retainArgsDays: number): McpCall {
    const args = retainArgsDays > 0 ? serialiseArgs(input.args) : null;
    const call: McpCall = {
      id: `mcp_${nanoid(10)}`,
      channel: input.channel,
      tool: input.tool,
      agentId: input.agentId,
      taskId: input.taskId,
      originRef: input.originRef,
      ok: input.ok,
      error: input.error,
      durationMs: input.durationMs,
      args,
      argsBytes: serialiseArgs(input.args)?.length ?? 0,
      argsDropped: false,
      createdAt: this.ctx.now(),
    };
    this.ctx.db
      .prepare(
        `INSERT INTO mcp_calls (id, channel, tool, agent_id, task_id, origin_ref, ok, error, duration_ms, args, args_bytes, args_dropped, created_at)
         VALUES (@id, @channel, @tool, @agentId, @taskId, @originRef, @ok, @error, @durationMs, @args, @argsBytes, 0, @createdAt)`,
      )
      .run({ ...call, ok: call.ok ? 1 : 0 });
    return call;
  }

  compactMcpCallArgs(retainDays: number, force = false): number {
    if (retainDays <= 0) {
      return this.clearArgs(null);
    }
    const nowMs = Date.parse(this.ctx.now());
    if (!force && this.lastCompactedAt !== null && nowMs - this.lastCompactedAt < COMPACT_INTERVAL_MS) return 0;
    this.lastCompactedAt = nowMs;
    return this.clearArgs(new Date(nowMs - retainDays * DAY_MS).toISOString());
  }

  private clearArgs(cutoff: string | null): number {
    const bound = cutoff === null ? '' : 'created_at < ? AND ';
    const result = this.ctx.db
      .prepare(`UPDATE mcp_calls SET args=NULL, args_dropped=1 WHERE ${bound}args_dropped=0 AND args IS NOT NULL`)
      .run(...(cutoff === null ? [] : [cutoff]));
    return result.changes;
  }

  listMcpCallsSince(since: string): McpCall[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM mcp_calls WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC`)
      .all(since) as McpCallRow[];
    return rows.map(rowToCall);
  }

  lastMcpCallByTool(): Map<string, string> {
    const rows = this.ctx.db
      .prepare(`SELECT channel, tool, MAX(created_at) AS last FROM mcp_calls GROUP BY channel, tool`)
      .all() as { channel: string; tool: string; last: string }[];
    return new Map(rows.map((r) => [`${r.channel}:${r.tool}`, r.last]));
  }

  countMcpCallsByAgent(): Map<string, number> {
    const rows = this.ctx.db
      .prepare(`SELECT agent_id AS agentId, COUNT(*) AS n FROM mcp_calls WHERE agent_id IS NOT NULL GROUP BY agent_id`)
      .all() as { agentId: string; n: number }[];
    return new Map(rows.map((r) => [r.agentId, r.n]));
  }
}

export const DEFAULT_MCP_ARGS_RETENTION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

const COMPACT_INTERVAL_MS = 60 * 60 * 1000;

function serialiseArgs(args: Record<string, unknown>): string | null {
  if (Object.keys(args).length === 0) return null;
  try {
    return JSON.stringify(args);
  } catch {
    return null;
  }
}

interface McpCallRow {
  id: string;
  channel: string;
  tool: string;
  agent_id: string | null;
  task_id: string | null;
  origin_ref: string | null;
  ok: number;
  error: string | null;
  duration_ms: number;
  args: string | null;
  args_bytes: number;
  args_dropped: number;
  created_at: string;
}

function rowToCall(r: McpCallRow): McpCall {
  return {
    id: r.id,
    channel: r.channel as McpCall['channel'],
    tool: r.tool,
    agentId: r.agent_id,
    taskId: r.task_id,
    originRef: r.origin_ref,
    ok: r.ok === 1,
    error: r.error,
    durationMs: r.duration_ms,
    args: r.args,
    argsBytes: r.args_bytes,
    argsDropped: r.args_dropped === 1,
    createdAt: r.created_at,
  };
}
