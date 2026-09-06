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

/** Absolute path to the shipped stdio bridge `claude` spawns. See {@link file://./bridge.mjs}. */
const BRIDGE_PATH = fileURLToPath(new URL('./bridge.mjs', import.meta.url));

interface McpBridgeServerOptions {
  store: Store;
  /**
   * Resolved lazily: the fleet and this server are mutually referential — an agent
   * launch needs a credential, a tool call needs the fleet.
   */
  agents: () => AgentToolTarget;
  /** Where per-agent `--mcp-config` files are written (one per launch, 0600). */
  configDir: string;
  /** The socket (POSIX) or named pipe (Windows) agents' bridges connect back on. */
  socketPath: string;
  /** This deployment's model profiles, cheapest first, for `appraise_issue` to offer an appraiser. Absent/empty = no `agentModels`, nothing asked or stored. */
  profiles?: { name: string; description: string }[];
  /** The project's review modes, in declaration order, for `review_route`. Absent/empty means a project that declared none — no triage is ever dispatched. */
  reviewModes?: string[];
  /** Whether `review_route` offers a skip — `review.allowSkip`. */
  reviewAllowSkip?: boolean;
  /** The project's area tree, for `appraise_issue` to say where a goal belongs. A thunk since it refreshes on the pulse. Absent/null = no tree, nothing offered. */
  areaPaths?: () => AreaPathTree | null;
  /** The permission backstop, resolved lazily (built after this server). `request_permission` reaches it, and {@link release} denies any request a leaving agent was blocked on. */
  permissions?: () => import('../agents/permissionDesk.js').PermissionDesk | undefined;
  /** What `open_pr` needs to author a pull request, resolved lazily. Absent, the tool says so and the agent opens its own PR. */
  openPr?: () => McpToolDeps['openPr'];
  /** Lazy: the sink it files through is built after this server. */
  filing?: () => McpToolDeps['filing'];
  /** Where `reply_to_review` hands a reply — the executor, built after this server, so lazy. Absent, the tool says replying is not wired. */
  prReply?: () => McpToolDeps['prReply'];
  /** The watch's dry run, resolved lazily — dropping this leaves `plan_submit` silently storing queries nobody ever put to an environment. */
  watch?: () => McpToolDeps['watch'];
  /** The author desk `review_pack_submit` hands a pack to. Lazy. */
  reviewPacks?: () => McpToolDeps['reviewPacks'];
  /** The checker desk `review_pack_check` hands its verdicts to. Lazy. */
  reviewPackChecker?: () => McpToolDeps['reviewPackChecker'];
  /** The desk the three local-validation tools write through, and the environment `local_run_read` reports on. Lazy — the local runner is the last component `system.ts` builds. */
  localValidations?: McpToolDeps['localValidations'];
  localRun?: McpToolDeps['localRun'];
  /** The checkout an obstacle's `path` key is validated against. Absent, no path key validates; the report is kept either way. */
  repoRoot?: string;
  /** How long a recorded call's arguments are kept, in days. `0` records none. Absent takes the store's own default. */
  argsRetentionDays?: number;
  errors?: ErrorRecorder;
}

/** A minted credential and the launch config that carries it, when one could be written. */
interface McpCredential {
  token: string;
  /** Path to pass as `--mcp-config`, or null when the server isn't listening (tools stay off). */
  configPath: string | null;
}

/** An in-process caller bound to one agent's identity. What tests drive instead of a socket. */
interface McpSession {
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/**
 * The typed channel back to the harness: a tools-only MCP server every spawned
 * agent is wired to. One server process, reached through a per-launch stdio
 * bridge. Identity is `token -> agent -> task -> origin`, minted at spawn and
 * carried in the launch config's env, never in a tool argument — an agent
 * cannot name itself, so it cannot address another agent's work. Transport is
 * a Unix domain socket (named pipe on Windows), never a TCP port. **Fail open,
 * everywhere**: a socket or config file that cannot be written leaves
 * {@link listen} false / `configPath` null and agents running on the
 * sentinels alone.
 */
export class McpBridgeServer {
  private readonly channel: SocketChannel;
  private readonly calls: McpCallLog;
  private listening = false;
  /** token -> agentId. Populated at spawn once the agent row exists. */
  private readonly identities = new Map<string, string | null>();

  constructor(private readonly opts: McpBridgeServerOptions) {
    this.calls = buildCallLog(opts);
    this.channel = new SocketChannel({
      socketPath: opts.socketPath,
      label: 'MCP tool channel (agents fall back to sentinels only)',
      // The path carries this harness's pid, so anything on it is debris.
      exclusive: false,
      dispatch: (token, _connectionId, frame) => this.dispatch(token, frame),
      errors: opts.errors,
    });
  }

  /**
   * Start listening. Best-effort by contract: a false return means agents launch
   * without the tool channel, not that anything failed.
   */
  async listen(): Promise<boolean> {
    if (this.listening) return true;
    mkdirSync(this.opts.configDir, { recursive: true });
    this.listening = await this.channel.listen();
    return this.listening;
  }

  /** Stop listening and drop every live bridge connection. */
  async close(): Promise<void> {
    this.listening = false;
    await this.channel.close();
  }

  /** Mint a credential for one launch. The token is always minted (so the in-process {@link session} path works even in tests that never listen); the config file is written only when there is a socket for it. */
  open(extra: readonly ExtraMcpServer[] = []): McpCredential {
    const token = randomUUID();
    this.identities.set(token, null);
    if (!this.listening) return { token, configPath: null };
    const configPath = join(this.opts.configDir, `${token}.json`);
    try {
      // 0600: the token is a bearer credential for this agent's identity, and the
      // config file is why it never has to appear in argv, where `ps` would show it.
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

  /** Bind a minted token to the agent row it belongs to, completing its identity. */
  bind(token: string, agentId: string): void {
    if (!this.identities.has(token)) return;
    this.identities.set(token, agentId);
  }

  /** Revoke a credential and remove its config file. Called when an agent leaves the fleet. */
  release(token: string): void {
    // Before the identity is dropped: deny anything this agent was blocked on at
    // the permission prompt, so a killed/crashed agent never leaves Claude waiting.
    const agentId = this.identities.get(token);
    if (agentId) this.opts.permissions?.()?.denyAll(agentId, 'The agent was stopped before this was decided.');
    this.identities.delete(token);
    try {
      rmSync(join(this.opts.configDir, `${token}.json`), { force: true });
    } catch {
      /* already gone */
    }
  }

  /** An in-process caller for an agent, or null if it has no live credential. Converges with the socket path on {@link invoke} — there is no test-only tool path. */
  session(agentId: string): McpSession | null {
    const token = [...this.identities.entries()].find(([, id]) => id === agentId)?.[0];
    if (!token) return null;
    return { call: (name, args) => this.invoke(token, name, args) };
  }

  /**
   * The `--mcp-config` document for one launch. The server key is
   * {@link MCP_SERVER_ID}: Claude Code derives the `mcp__<key>__<tool>`
   * permission names from it, which is what `--allowedTools` grants. `extra`
   * goes in **this** document rather than a second `--mcp-config`, so a launch
   * writes one 0600 file and the grants come off one list.
   */
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
      // A dispatch naming our own key would replace the fleet's channel with
      // somebody else's tools. Dropped and recorded rather than thrown.
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

  /** Run one tool by name for a token's identity. The seam both transports share. */
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

  /** Resolve a token to its caller, or explain why it can't be. */
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

  /**
   * Answer one request frame against the tools of the token's identity. Every
   * `tools/call` that gets this far is recorded, including ones refused for
   * want of an identity — see `src/mcpInsights.ts`. The record is taken
   * *after* the answer and never changes it.
   */
  private async dispatch(token: string, frame: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const call = this.calls.callOf(frame);
    const startedAt = Date.now();
    const resolved = this.resolve(token);
    if (!resolved.ok) {
      // `initialize`/`tools/list` are still answered (empty tool set) so a bridge
      // racing ahead of `bind` completes its handshake and can retry.
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
        reviewPacks: this.opts.reviewPacks?.(),
        reviewPackChecker: this.opts.reviewPackChecker?.(),
        // Thunks, so a tool reads the desk at call time rather than resolving on
        // every request.
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
        // The origin as it is *now*: a task retargeted later would otherwise
        // re-file every call it ever made under a different phase.
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

/**
 * Where the bridge socket lives. Per-pid so two harnesses on one machine don't
 * fight over the path, and under the OS tmpdir to stay well inside the ~104-char
 * limit POSIX imposes on socket paths (a repo-relative path easily exceeds it).
 */
export function defaultSocketPath(pid: number = process.pid): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\lubbdubb-mcp-${pid}`;
  return join(tmpdir(), 'lubbdubb', `mcp-${pid}.sock`);
}

/** Where per-agent launch configs are written. */
export function defaultConfigDir(): string {
  return join(tmpdir(), 'lubbdubb', 'mcp');
}
