import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtraMcpServer } from '../types.js';
import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import {
  handleRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
  toolError,
  type ToolCallResult,
} from './protocol.js';
import { SocketChannel } from './socketChannel.js';
import { buildCallLog, type McpCallLog } from './callLog.js';
import { MCP_SERVER_ID } from './names.js';
import { buildTools } from './tools.js';
import type { AgentToolTarget, McpIdentity, McpToolDeps } from './tools/context.js';
import type { AreaPathTree } from '../intake/placement.js';

// → docs/spec/11-mcp-tools.md

const BRIDGE_PATH = fileURLToPath(new URL('./bridge.mjs', import.meta.url));

interface McpBridgeServerOptions {
  store: Store;
  agents: () => AgentToolTarget;
  configDir: string;
  socketPath: string;
  profiles?: { name: string; description: string }[];
  reviewModes?: string[];
  reviewAllowSkip?: boolean;
  areaPaths?: () => AreaPathTree | null;
  permissions?: () => import('../agents/permissionDesk.js').PermissionDesk | undefined;
  openPr?: () => McpToolDeps['openPr'];
  filing?: () => McpToolDeps['filing'];
  prReply?: () => McpToolDeps['prReply'];
  watch?: () => McpToolDeps['watch'];
  state?: () => McpToolDeps['state'];
  reviewPacks?: () => McpToolDeps['reviewPacks'];
  reviewPackChecker?: () => McpToolDeps['reviewPackChecker'];
  localValidations?: McpToolDeps['localValidations'];
  localRun?: McpToolDeps['localRun'];
  repoRoot?: string;
  argsRetentionDays?: number;
  errors?: ErrorRecorder;
}

interface McpCredential {
  token: string;
  configPath: string | null;
}

interface McpSession {
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export class McpBridgeServer {
  private readonly channel: SocketChannel;
  private readonly calls: McpCallLog;
  private listening = false;
  private readonly identities = new Map<string, string | null>();

  constructor(private readonly opts: McpBridgeServerOptions) {
    this.calls = buildCallLog(opts);
    this.channel = new SocketChannel({
      socketPath: opts.socketPath,
      label: 'MCP tool channel (agents fall back to sentinels only)',
      exclusive: false,
      dispatch: (token, _connectionId, frame) => this.dispatch(token, frame),
      errors: opts.errors,
    });
  }

  async listen(): Promise<boolean> {
    if (this.listening) return true;
    mkdirSync(this.opts.configDir, { recursive: true });
    this.listening = await this.channel.listen();
    return this.listening;
  }

  async close(): Promise<void> {
    this.listening = false;
    await this.channel.close();
  }

  open(extra: readonly ExtraMcpServer[] = []): McpCredential {
    const token = randomUUID();
    this.identities.set(token, null);
    if (!this.listening) return { token, configPath: null };
    const configPath = join(this.opts.configDir, `${token}.json`);
    try {
      writeFileSync(configPath, JSON.stringify(this.launchConfig(token, extra)), { mode: 0o600 });
    } catch (err) {
      this.opts.errors?.record({
        source: 'agent',
        message: `Could not write MCP launch config (this agent falls back to sentinels only): ${(err as Error).message}`,
      });
      return { token, configPath: null };
    }
    return { token, configPath };
  }

  bind(token: string, agentId: string): void {
    if (!this.identities.has(token)) return;
    this.identities.set(token, agentId);
  }

  release(token: string): void {
    const agentId = this.identities.get(token);
    if (agentId) this.opts.permissions?.()?.denyAll(agentId, 'The agent was stopped before this was decided.');
    this.identities.delete(token);
    try {
      rmSync(join(this.opts.configDir, `${token}.json`), { force: true });
    } catch {
      /* already gone */
    }
  }

  session(agentId: string): McpSession | null {
    const token = [...this.identities.entries()].find(([, id]) => id === agentId)?.[0];
    if (!token) return null;
    return { call: (name, args) => this.invoke(token, name, args) };
  }

  private launchConfig(token: string, extra: readonly ExtraMcpServer[]): unknown {
    const mcpServers: Record<string, unknown> = {
      [MCP_SERVER_ID]: {
        type: 'stdio',
        command: process.execPath,
        args: [BRIDGE_PATH],
        env: { LUBBDUBB_MCP_SOCKET: this.opts.socketPath, LUBBDUBB_MCP_TOKEN: token },
      },
    };
    for (const server of extra) {
      if (server.key === MCP_SERVER_ID) {
        this.opts.errors?.record({
          source: 'agent',
          message: `An extra MCP server asked for the key "${MCP_SERVER_ID}", which is the harness's own channel. It was dropped from this launch.`,
        });
        continue;
      }
      mcpServers[server.key] = { type: 'stdio', command: server.command, args: server.args };
    }
    return { mcpServers };
  }

  private async invoke(token: string, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const response = await this.dispatch(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const result = response?.result as ToolCallResult | undefined;
    if (result) return result;
    return { content: [{ type: 'text', text: response?.error?.message ?? 'no response' }], isError: true };
  }

  private resolve(token: string): { ok: true; identity: McpIdentity } | { ok: false; error: string } {
    const agentId = this.identities.get(token);
    if (agentId === undefined) return { ok: false, error: 'unknown or revoked agent credential' };
    if (agentId === null) return { ok: false, error: 'agent credential is not bound yet; retry' };
    const agent = this.opts.store.getAgent(agentId);
    if (!agent) return { ok: false, error: 'agent no longer exists' };
    const task = this.opts.store.getTask(agent.taskId);
    if (!task) return { ok: false, error: 'agent has no task' };
    return { ok: true, identity: { agent, task } };
  }

  private async dispatch(token: string, frame: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const call = this.calls.callOf(frame);
    const startedAt = Date.now();
    const resolved = this.resolve(token);
    if (!resolved.ok) {
      if (frame.method === 'tools/call') {
        if (call !== null) {
          this.calls.record({
            channel: 'fleet',
            tool: call.tool,
            agentId: null,
            taskId: null,
            originRef: null,
            ok: false,
            error: resolved.error,
            durationMs: Date.now() - startedAt,
            args: call.args,
          });
        }
        return { jsonrpc: '2.0', id: frame.id ?? null, result: toolError(resolved.error) };
      }
      return await handleRequest(frame, []);
    }
    const tools = buildTools(
      {
        store: this.opts.store,
        agents: this.opts.agents(),
        profiles: this.opts.profiles,
        reviewModes: this.opts.reviewModes,
        reviewAllowSkip: this.opts.reviewAllowSkip,
        areaPaths: this.opts.areaPaths,
        permissions: this.opts.permissions?.(),
        openPr: this.opts.openPr?.(),
        filing: this.opts.filing?.(),
        prReply: this.opts.prReply?.(),
        watch: this.opts.watch?.(),
        state: this.opts.state?.(),
        reviewPacks: this.opts.reviewPacks?.(),
        reviewPackChecker: this.opts.reviewPackChecker?.(),
        localValidations: this.opts.localValidations,
        localRun: this.opts.localRun,
        repoRoot: this.opts.repoRoot,
        errors: this.opts.errors,
      },
      resolved.identity,
    );
    const response = await handleRequest(frame, tools);
    if (call !== null) {
      const refusal = this.calls.refusalOf(response);
      this.calls.record({
        channel: 'fleet',
        tool: call.tool,
        agentId: resolved.identity.agent.id,
        taskId: resolved.identity.task.id,
        originRef: resolved.identity.task.originRef,
        ok: refusal === null,
        error: refusal,
        durationMs: Date.now() - startedAt,
        args: call.args,
      });
    }
    return response;
  }
}

export function defaultSocketPath(pid: number = process.pid): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\lubbdubb-mcp-${pid}`;
  return join(tmpdir(), 'lubbdubb', `mcp-${pid}.sock`);
}

export function defaultConfigDir(): string {
  return join(tmpdir(), 'lubbdubb', 'mcp');
}
