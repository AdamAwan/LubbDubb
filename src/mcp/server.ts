import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
   * Resolved lazily: the fleet and this server are mutually referential (an agent
   * launch needs a credential; a tool call needs the fleet), and a thunk is the
   * honest way to say "not until someone actually calls a tool".
   */
  agents: () => AgentToolTarget;
  /** Where per-agent `--mcp-config` files are written (one per launch, 0600). */
  configDir: string;
  /** The socket (POSIX) or named pipe (Windows) agents' bridges connect back on. */
  socketPath: string;
  /**
   * This deployment's model profiles, cheapest first, for `appraise_issue` to offer
   * an appraiser (issue #342). Absent/empty = no `agentModels`, and then no
   * profile is asked for and none is stored.
   */
  profiles?: { name: string; description: string }[];
  /**
   * The project's area tree, for `appraise_issue` to offer an appraiser when it says
   * where a goal belongs. A thunk for {@link agents}' reason — the directory
   * behind it refreshes on the pulse. Absent/null = no tree the harness could
   * read, and then nothing is offered and nothing accepted.
   */
  areaPaths?: () => AreaPathTree | null;
  /**
   * The permission backstop (issue #130 phase B), resolved lazily for the same
   * reason as {@link agents}: it is built after this server (it needs the
   * escalation inbox, which needs the fleet). The `request_permission` tool reaches
   * it, and {@link release} denies any request a leaving agent was blocked on.
   */
  permissions?: () => import('../agents/permissionDesk.js').PermissionDesk | undefined;
  /**
   * What `open_pr` needs to author a pull request, resolved lazily like the two
   * above. Absent, the tool says so and the agent opens its own PR — the floor
   * every prompt still describes.
   */
  openPr?: () => McpToolDeps['openPr'];
  /** Lazy for `openPr`'s reason: the sink it files through is built after this server. */
  filing?: () => McpToolDeps['filing'];
  /**
   * Where `reply_to_review` hands a reply — the executor, which is built after
   * this server, so lazy for `openPr`'s reason and with the same floor: absent,
   * the tool says replying is not wired rather than sending anything itself.
   */
  prReply?: () => McpToolDeps['prReply'];
  /**
   * How long a recorded call's arguments are kept, in days. `0` records none at
   * all. Absent takes the store's own default — see `McpCallStore`.
   */
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
 * The typed channel back to the harness (issue #108): a tools-only MCP server
 * every spawned agent is wired to.
 *
 * **Shape.** One server process — this one, inside the harness — rather than one
 * per agent. Agents reach it through a per-launch stdio bridge that is a pure
 * pipe, so there is a single store connection and no protocol logic outside this
 * module. Identity is `token -> agent -> task -> origin`, minted at spawn and
 * carried in the launch config's env rather than in any tool argument: an agent
 * cannot name itself, so it cannot address another agent's work.
 *
 * **Transport.** A Unix domain socket (named pipe on Windows), never a TCP port.
 * The cockpit's HTTP surface is already unauthenticated on `0.0.0.0`; a second
 * one with fleet-wide write access to the store is not a trade worth making.
 *
 * **Fail open, everywhere.** If the socket can't be created, {@link listen}
 * returns false, {@link open} hands back a null `configPath`, no `--mcp-config`
 * is passed, and agents run exactly as they do today on the sentinels alone. The
 * same is true per-agent if the config file can't be written. Nothing here is on
 * the critical path of an agent finishing its work.
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

  /**
   * Mint a credential for one launch. The token is always minted (so the
   * in-process {@link session} path works even in tests that never listen); the
   * config file is written only when there is a socket for it to point at.
   */
  open(): McpCredential {
    const token = randomUUID();
    this.identities.set(token, null);
    if (!this.listening) return { token, configPath: null };
    const configPath = join(this.opts.configDir, `${token}.json`);
    try {
      // 0600: the token is a bearer credential for this agent's identity, and the
      // config file is why it never has to appear in argv, where `ps` would show it.
      writeFileSync(configPath, JSON.stringify(this.launchConfig(token)), { mode: 0o600 });
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

  /**
   * An in-process caller for an agent, or null if it has no live credential. The
   * socket path and this one converge on {@link invoke}, so a test drives exactly
   * the code an agent's bridge reaches — there is no test-only tool path.
   */
  session(agentId: string): McpSession | null {
    const token = [...this.identities.entries()].find(([, id]) => id === agentId)?.[0];
    if (!token) return null;
    return { call: (name, args) => this.invoke(token, name, args) };
  }

  /**
   * The `--mcp-config` document for one launch. The server key is
   * {@link MCP_SERVER_ID} because Claude Code derives the `mcp__<key>__<tool>`
   * permission names from it, and those are what `--allowedTools` grants.
   */
  private launchConfig(token: string): unknown {
    return {
      mcpServers: {
        [MCP_SERVER_ID]: {
          type: 'stdio',
          command: process.execPath,
          args: [BRIDGE_PATH],
          env: { LUBBDUBB_MCP_SOCKET: this.opts.socketPath, LUBBDUBB_MCP_TOKEN: token },
        },
      },
    };
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
   * Answer one request frame against the tools of the token's identity.
   *
   * **Every `tools/call` that gets this far is recorded**, including the ones
   * refused for want of an identity — those especially. A run whose
   * `mcp__lubbdubb__*` grants were dropped makes no call at all and so appears
   * here not once; that silence is only legible against the runs that existed,
   * which is why the usage reading joins these rows to `agents` rather than
   * reading them alone. See `src/mcpInsights.ts`.
   *
   * The record is taken *after* the answer, so it carries what the tool actually
   * did, and it is never allowed to change the answer: the frame is dispatched,
   * the response is what this returns, and the row is written on the way past.
   */
  private async dispatch(token: string, frame: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const call = this.calls.callOf(frame);
    const startedAt = Date.now();
    const resolved = this.resolve(token);
    if (!resolved.ok) {
      // `initialize`/`tools/list` are still answered (with an empty tool set) so a
      // bridge that raced ahead of `bind` completes its handshake and can retry;
      // only an actual tool call needs a real identity behind it, and it gets the
      // reason as a handled error rather than a dead channel.
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
        areaPaths: this.opts.areaPaths,
        permissions: this.opts.permissions?.(),
        openPr: this.opts.openPr?.(),
        filing: this.opts.filing?.(),
        prReply: this.opts.prReply?.(),
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
        // The origin as it is *now*, copied onto the row: a task retargeted later
        // would otherwise silently re-file every call it ever made under a
        // different phase.
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
