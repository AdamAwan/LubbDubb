import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { McpCallInput } from '../types.js';
import { DEFAULT_MCP_ARGS_RETENTION_DAYS } from '../store/mcpCalls.js';
import { toolCallFrame } from './protocol.js';
import type { JsonRpcRequest, JsonRpcResponse } from './protocol.js';

/**
 * What both channels write to `mcp_calls`, in one place.
 *
 * The two servers resolve identity in ways that have nothing in common — the
 * fleet's `token -> agent -> task -> origin`, the desktop's `token ->
 * connection -> claim` — but what they record is one shape and one set of rules,
 * and those rules are the reason this is not two `store.recordMcpCall` calls
 * written twice:
 *
 * **Recording must never turn a working call into a failed one.** It sits on the
 * call path of every tool on both channels, and it is bookkeeping: a store that
 * refuses a row is a reading lost, not a tool call lost. So every write here is
 * wrapped, and a failure goes to the error log and no further.
 *
 * **A refused call is the most valuable row in the table.** Both servers answer
 * `tools/call` on an unresolvable credential with a handled `toolError` rather
 * than a dead channel, and that answer is exactly the shape of the failure the
 * usage reading exists to surface — so it is recorded like any other call, with
 * a null identity and `ok` false, rather than skipped for having no agent behind
 * it.
 *
 * → `docs/spec/11-mcp-tools.md#what-is-recorded`
 */
export interface McpCallLog {
  /**
   * Record one settled call. Fire-and-forget by contract: the return value is
   * `void` so no caller can come to depend on the row.
   */
  record(input: McpCallInput): void;
  /**
   * The tool name and arguments a `tools/call` frame carries, or null if it is
   * not one.
   *
   * Here rather than at each call site because both servers already branch on
   * `frame.method === 'tools/call'` for their own reasons, and a second,
   * differently-written parse of the same params is how one channel comes to
   * record a name the other does not.
   */
  callOf(frame: JsonRpcRequest): { tool: string; args: Record<string, unknown> } | null;
  /** Whether a dispatched response carried a tool refusal, and what it said. */
  refusalOf(response: JsonRpcResponse | null): string | null;
}

export function buildCallLog(deps: {
  store: Store;
  /** How long arguments are kept. `0` records none at all — see `McpCallStore`. */
  argsRetentionDays?: number;
  errors?: ErrorRecorder;
}): McpCallLog {
  const retain = deps.argsRetentionDays ?? DEFAULT_MCP_ARGS_RETENTION_DAYS;
  return {
    record(input) {
      try {
        deps.store.recordMcpCall(input, retain);
        // On the write path rather than a timer, because a fleet making calls is
        // the only one accumulating arguments — and the store rate-limits it to
        // hourly, so this costs one indexed `UPDATE` a day's worth of calls apart.
        deps.store.compactMcpCallArgs(retain);
      } catch (err) {
        deps.errors?.record({
          source: 'agent',
          message: `Could not record an MCP call (the tool itself was unaffected): ${(err as Error).message}`,
        });
      }
    },
    callOf: toolCallFrame,
    refusalOf(response) {
      const result = response?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
      if (result?.isError !== true) return response?.error?.message ?? null;
      // The tool's own words, which is what makes a refusal legible in the panel:
      // "plan rejected: a part names no files" says which contract is refusing,
      // where a bare `isError` says only that something did.
      return (
        result.content
          ?.map((c) => c.text ?? '')
          .join(' ')
          .trim() || 'refused without a reason'
      );
    },
  };
}
