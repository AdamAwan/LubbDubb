import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { McpCallInput } from '../types.js';
import { DEFAULT_MCP_ARGS_RETENTION_DAYS } from '../store/mcpCalls.js';
import { toolCallFrame } from './protocol.js';
import type { JsonRpcRequest, JsonRpcResponse } from './protocol.js';

// → docs/spec/11-mcp-tools.md

export interface McpCallLog {
  record(input: McpCallInput): void;
  callOf(frame: JsonRpcRequest): { tool: string; args: Record<string, unknown> } | null;
  refusalOf(response: JsonRpcResponse | null): string | null;
}

export function buildCallLog(deps: { store: Store; argsRetentionDays?: number; errors?: ErrorRecorder }): McpCallLog {
  const retain = deps.argsRetentionDays ?? DEFAULT_MCP_ARGS_RETENTION_DAYS;
  return {
    record(input) {
      try {
        deps.store.recordMcpCall(input, retain);
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
      return (
        result.content
          ?.map((c) => c.text ?? '')
          .join(' ')
          .trim() || 'refused without a reason'
      );
    },
  };
}
