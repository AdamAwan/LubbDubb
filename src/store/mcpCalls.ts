import { nanoid } from 'nanoid';
import type { McpCall, McpCallInput } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `mcp_calls` table: every tool call that reached a tool body, on either
 * channel.
 *
 * A brand-new table, so no `ColumnMigrations` entry — but being new *once* does
 * not keep it exempt, and a column added to it later needs one.
 *
 * **Nothing here gates anything.** No dispatch rule, desk or tool reads this
 * store; the only reader is `buildMcpInsights`. That is deliberate and is the
 * property that makes recording safe to do on the call path: a write that fails
 * must never turn a working tool call into a refused one, so
 * {@link recordMcpCall} is called for its effect and its return value is
 * discarded by both servers.
 *
 * → `docs/spec/14-persistence.md#mcp-calls`, `docs/spec/11-mcp-tools.md#what-is-recorded`
 */
export class McpCallStore {
  /**
   * When the argument sweep last ran, as ms since epoch, or null if it has not
   * this process.
   *
   * In memory rather than on a row because it is a rate limit and not a fact: the
   * sweep is idempotent, so the worst a lost value can do is run it once more on
   * the next boot, and a table nothing else needs is not worth carrying for that.
   */
  private lastCompactedAt: number | null = null;

  constructor(private readonly ctx: StoreContext) {}

  /**
   * Record one call.
   *
   * **Arguments are stored whole or not at all.** There is no truncation, because
   * a half-argument answers neither question the column exists for — what an
   * agent actually passes, and what a refusal was passed. `args_bytes` is written
   * from the same serialisation, so the size reading survives the compaction that
   * removes the text.
   *
   * `retainArgsDays` of `0` means the deployment does not want arguments recorded
   * at all, and then none are written in the first place — the compaction is not
   * the off switch, this is. Anything above zero writes them and lets
   * {@link compactArgs} clear them on its own schedule.
   */
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
      // Measured from the serialisation whether or not it is kept, so a
      // deployment that records no arguments still knows how big its calls are.
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

  /**
   * Clear the arguments of every call older than `retainDays`, at most hourly.
   *
   * **The rows stay.** Only the arguments go, and that is the whole of the
   * compaction — which is not what "compact to aggregated numbers" usually means,
   * and is the better trade here for two reasons. A row without its arguments is
   * about eighty bytes, so the count readings stay *exact* at every window the
   * page offers, `all` included; and an aggregate would have to be summed at some
   * grain, which would fix now what a later reading is allowed to ask. The size
   * that actually grows without bound is the arguments — a submitted plan
   * document is tens of kilobytes — and that is the part this removes.
   *
   * `args_dropped` is set as the text is cleared, because a compacted call and a
   * call that carried no arguments are different facts that would otherwise both
   * read as `args IS NULL`: the panel would report a fortnight of empty calls and
   * be believed.
   *
   * Called from the write path and from boot. From the write path because a fleet
   * making calls is the only one accumulating arguments, so the sweep costs
   * nothing on an idle harness; from boot as well because an idle harness would
   * otherwise hold arguments past their window with nothing to trigger the sweep
   * — a retention promise kept only while busy is not one.
   *
   * Returns how many rows it cleared, for the caller that wants to log it.
   */
  compactMcpCallArgs(retainDays: number, force = false): number {
    if (retainDays <= 0) {
      // Every row, with **no date bound at all** — not a cutoff of `now`. A
      // deployment that stops recording arguments must lose the ones it already
      // has, and a row written in the same millisecond as the sweep is not older
      // than it: bounded by `now` this would keep exactly the arguments an
      // operator had just switched off, for ever, and report having cleared them.
      return this.clearArgs(null);
    }
    const nowMs = Date.parse(this.ctx.now());
    if (!force && this.lastCompactedAt !== null && nowMs - this.lastCompactedAt < COMPACT_INTERVAL_MS) return 0;
    this.lastCompactedAt = nowMs;
    return this.clearArgs(new Date(nowMs - retainDays * DAY_MS).toISOString());
  }

  /** `cutoff` null clears every row that still carries arguments, whatever its age. */
  private clearArgs(cutoff: string | null): number {
    const bound = cutoff === null ? '' : 'created_at < ? AND ';
    const result = this.ctx.db
      .prepare(`UPDATE mcp_calls SET args=NULL, args_dropped=1 WHERE ${bound}args_dropped=0 AND args IS NOT NULL`)
      .run(...(cutoff === null ? [] : [cutoff]));
    return result.changes;
  }

  /**
   * Every call at or after `since`, oldest first — the ordering every other
   * windowed read in this store uses, and the one the timeline folds in.
   */
  listMcpCallsSince(since: string): McpCall[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM mcp_calls WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC`)
      .all(since) as McpCallRow[];
    return rows.map(rowToCall);
  }

  /**
   * When each tool was last called **on each channel**, over all time, keyed
   * `channel:tool`.
   *
   * Deliberately *not* windowed, and it is the one read here that is not. The
   * silence reading's most useful sentence is "nothing has called this in the
   * window, and the last call was nineteen days ago" — a date the window by
   * definition cannot contain. A tool never called at all is absent from the map
   * rather than present with a null, so the caller distinguishes the two.
   *
   * The channel is in the key because the two are never summed and never
   * borrowed from each other: `validation_report` is the one name on both, and
   * grouped by tool alone the fleet's row reported an operator's own desktop
   * call as its own — a "nothing named it" verdict beside a timestamp from
   * seconds ago.
   */
  lastMcpCallByTool(): Map<string, string> {
    const rows = this.ctx.db
      .prepare(`SELECT channel, tool, MAX(created_at) AS last FROM mcp_calls GROUP BY channel, tool`)
      .all() as { channel: string; tool: string; last: string }[];
    return new Map(rows.map((r) => [`${r.channel}:${r.tool}`, r.last]));
  }
}

/** How long a call's arguments are kept when the config states nothing. */
export const DEFAULT_MCP_ARGS_RETENTION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The shortest gap between two argument sweeps.
 *
 * The sweep is a single indexed `UPDATE` and would be affordable per call, but
 * per call is thousands of times a day to clear rows that age in at a trickle.
 * Hourly is well under the resolution of a fourteen-day window.
 */
const COMPACT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The arguments as one JSON string, or null when there are none.
 *
 * A throw here would turn a working tool call into a failed one, which is the
 * thing recording must never do: an argument object that will not serialise —
 * a cycle, a BigInt — is recorded as absent rather than allowed out of this
 * function.
 */
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
