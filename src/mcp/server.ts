import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import { debugLog } from '../debug.js';
import {
  handleRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
  parseFrame,
  toolError,
  type ToolCallResult,
} from './protocol.js';
import { MCP_SERVER_ID } from './names.js';
import { buildTools } from './tools.js';
import type { AgentToolTarget, McpIdentity, McpToolDeps } from './tools/context.js';

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
   * `planning.requireApproval`, passed through to `plan_submit`'s ingestion so
   * the tool transport and the `plan.json` one persist a verdict identically —
   * the property the shared `ingestPlanDocument` exists to keep.
   */
  requirePlanApproval?: boolean;
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
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  /** token -> agentId. Populated at spawn once the agent row exists. */
  private readonly identities = new Map<string, string | null>();

  constructor(private readonly opts: McpBridgeServerOptions) {}

  /**
   * Start listening. Best-effort by contract: a false return means agents launch
   * without the tool channel, not that anything failed. A stale socket file from
   * a crashed run is removed first — binding is the only way to tell a dead
   * socket from a live one, and a live one means another harness owns this path.
   */
  async listen(): Promise<boolean> {
    if (this.server) return true;
    mkdirSync(this.opts.configDir, { recursive: true });
    if (!this.opts.socketPath.startsWith('\\\\')) {
      try {
        rmSync(this.opts.socketPath, { force: true });
      } catch {
        /* nothing to clear */
      }
    }
    const server = createServer((socket) => this.accept(socket));
    const started = await new Promise<boolean>((resolve) => {
      server.once('error', (err: Error) => {
        this.opts.errors?.record({
          source: 'agent',
          message: `MCP tool channel unavailable (agents fall back to sentinels only): ${err.message}`,
        });
        resolve(false);
      });
      server.listen(this.opts.socketPath, () => resolve(true));
    });
    if (!started) return false;
    // A listener must never take the process down; a dropped bridge is routine.
    server.on('error', () => {});
    this.server = server;
    debugLog('mcp', `listening on ${this.opts.socketPath}`);
    return true;
  }

  /** Stop listening and drop every live bridge connection. */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Mint a credential for one launch. The token is always minted (so the
   * in-process {@link session} path works even in tests that never listen); the
   * config file is written only when there is a socket for it to point at.
   */
  open(): McpCredential {
    const token = randomUUID();
    this.identities.set(token, null);
    if (!this.server) return { token, configPath: null };
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

  /** Answer one request frame against the tools of the token's identity. */
  private async dispatch(token: string, frame: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const resolved = this.resolve(token);
    if (!resolved.ok) {
      // `initialize`/`tools/list` are still answered (with an empty tool set) so a
      // bridge that raced ahead of `bind` completes its handshake and can retry;
      // only an actual tool call needs a real identity behind it, and it gets the
      // reason as a handled error rather than a dead channel.
      if (frame.method === 'tools/call') {
        return { jsonrpc: '2.0', id: frame.id ?? null, result: toolError(resolved.error) };
      }
      return await handleRequest(frame, []);
    }
    const tools = buildTools(
      {
        store: this.opts.store,
        agents: this.opts.agents(),
        requirePlanApproval: this.opts.requirePlanApproval,
        permissions: this.opts.permissions?.(),
        openPr: this.opts.openPr?.(),
        errors: this.opts.errors,
      },
      resolved.identity,
    );
    return await handleRequest(frame, tools);
  }

  /** One bridge connection: a handshake line, then newline-delimited JSON-RPC. */
  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let token: string | null = null;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (token === null) {
          token = handshakeToken(line);
          // A connection that doesn't identify itself gets nothing — the token is
          // the only thing standing between a local process and the whole fleet's store.
          if (token === null) {
            socket.destroy();
            return;
          }
          continue;
        }
        void this.serve(socket, token, line);
      }
    });
  }

  /** Handle one frame from a live bridge, writing the response back if there is one. */
  private async serve(socket: Socket, token: string, line: string): Promise<void> {
    const frame = parseFrame(line);
    if (!frame) return; // unparsable noise; a notification-shaped frame takes no reply either
    try {
      const response = await this.dispatch(token, frame);
      if (response) socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      // Never let one bad frame kill the channel for the rest of the agent's run.
      this.opts.errors?.record({ source: 'agent', message: `MCP frame failed: ${(err as Error).message}` });
    }
  }
}

/** The token from a bridge's opening handshake line, or null if it isn't one. */
function handshakeToken(line: string): string | null {
  try {
    const value = JSON.parse(line) as { lubbdubb?: unknown; token?: unknown };
    if (value?.lubbdubb !== 1 || typeof value.token !== 'string' || !value.token) return null;
    return value.token;
  } catch {
    return null;
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
