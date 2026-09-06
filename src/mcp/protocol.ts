import { MCP_SERVER_ID } from './names.js';

// → docs/spec/11-mcp-tools.md

const MCP_PROTOCOL_VERSION = '2024-11-05';

const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
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

export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult> | ToolCallResult;
  hidden?: boolean;
}

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

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

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
        return rpcResult(id, toolError(`${name} failed: ${(err as Error).message}`));
      }
    }
    default:
      return isNotification ? null : rpcError(id, RPC_ERRORS.methodNotFound, `unknown method "${req.method}"`);
  }
}

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

export function toolJson(payload: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function toolError(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
