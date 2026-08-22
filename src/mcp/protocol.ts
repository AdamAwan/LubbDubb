/**
 * The MCP wire protocol, as pure functions.
 *
 * MCP over stdio is JSON-RPC 2.0 in newline-delimited JSON. The agent-side
 * {@link file://./bridge.mjs} is a dumb pipe — it forwards frames between
 * `claude` and the harness socket and understands none of this — so every
 * protocol decision lives here, in the harness, where it is unit-testable
 * without a live `claude` or any transport at all.
 *
 * Only the handful of methods a tools-only server must answer are implemented;
 * anything else returns a proper `method not found` rather than silence, so a
 * client mismatch shows up as an error instead of a hang.
 */

import { MCP_SERVER_ID } from './names.js';

/** The MCP revision we negotiate. Echoed back on `initialize`. */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC error codes we emit (the standard set; MCP adds no others here). */
const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** Absent for notifications, which take no response. */
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A tool's result content, in MCP's shape. `isError` marks a *handled* failure. */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** One exposed tool: its advertised schema plus the handler that runs it. */
export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as advertised to the model. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult> | ToolCallResult;
  /**
   * Answered, but never advertised — what a **retired** name is (`src/mcp/names.ts`).
   *
   * The two halves are both load-bearing and pull opposite ways. Out of
   * `tools/list`, because a withdrawn tool must not be one of the doors an agent
   * chooses between. Still dispatchable, because a prompt override written before
   * the withdrawal still names it, and an unknown-method error reaches the agent
   * as a broken channel and appears in no reading at all — where a refusal that
   * names the replacement is both an answer and a recorded call.
   */
  hidden?: boolean;
}

/** Parse one newline-delimited frame, or null when it isn't a usable request. */
export function parseFrame(line: string): JsonRpcRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const req = value as Partial<JsonRpcRequest>;
  if (typeof req.method !== 'string') return null;
  return {
    jsonrpc: '2.0',
    id: req.id ?? undefined,
    method: req.method,
    params: (req.params as Record<string, unknown> | undefined) ?? {},
  };
}

/** A successful response envelope. */
function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** An error response envelope. */
function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Answer one request against a tool set. Returns null for notifications (which
 * must produce no frame at all) — including a request whose method we don't know
 * but that carries no id, since replying to a notification is itself a protocol
 * violation.
 *
 * Never throws: a handler that blows up becomes an `isError` tool result, so an
 * agent gets a message it can act on instead of a dead channel. That is the whole
 * point of the tool path over the `plan.json` one.
 */
export async function handleRequest(req: JsonRpcRequest, tools: McpTool[]): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;

  switch (req.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_ID, version: '1' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return isNotification ? null : rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: tools
          .filter((t) => t.hidden !== true)
          .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const call = toolCallFrame(req);
      if (call === null) return rpcError(id, RPC_ERRORS.invalidParams, 'tools/call requires a tool name');
      const { tool: name, args } = call;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return rpcError(id, RPC_ERRORS.invalidParams, `unknown tool "${name}"`);
      try {
        return rpcResult(id, await tool.handler(args));
      } catch (err) {
        // A thrown handler is a harness bug, not the agent's fault — but the agent
        // is the one blocked, so it hears about it in a form it can retry against.
        return rpcResult(id, toolError(`${name} failed: ${(err as Error).message}`));
      }
    }
    default:
      return isNotification ? null : rpcError(id, RPC_ERRORS.methodNotFound, `unknown method "${req.method}"`);
  }
}

/**
 * The tool name and arguments a frame carries, or null when it is not a
 * well-formed `tools/call`.
 *
 * One parse, reached from three places: this module's own dispatch, and both
 * channels' call recording. Written separately at each, the recording would be
 * free to disagree with the dispatch about what was called — which is a usage
 * reading naming a tool nothing ran, with nothing to catch it.
 */
export function toolCallFrame(req: JsonRpcRequest): { tool: string; args: Record<string, unknown> } | null {
  if (req.method !== 'tools/call') return null;
  const name = req.params?.name;
  if (typeof name !== 'string') return null;
  const rawArgs = req.params?.arguments;
  return {
    tool: name,
    args: typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {},
  };
}

/** A tool result carrying a JSON payload (the shape every LubbDubb tool returns). */
export function toolJson(payload: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** A *handled* tool failure — the agent reads the message and retries in its own turn. */
export function toolError(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
