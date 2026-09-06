import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleRequest,
  toolError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolCallResult,
} from './protocol.js';
import { SocketChannel } from './socketChannel.js';
import { buildCallLog, type McpCallLog } from './callLog.js';
import type { DesktopSession, DesktopToolDeps } from './desktopContext.js';
import { buildDesktopTools } from './desktopTools.js';

// → docs/spec/11-mcp-tools.md

const BRIDGE_PATH = fileURLToPath(new URL('./bridge.mjs', import.meta.url));

interface McpDesktopServerOptions extends DesktopToolDeps {
  socketPath: string;
  credentialPath: string;
  argsRetentionDays?: number;
}

export class McpDesktopServer {
  private readonly channel: SocketChannel;
  private readonly calls: McpCallLog;
  private token: string | null = null;
  private readonly sessions = new Map<string, DesktopSession>();

  constructor(private readonly opts: McpDesktopServerOptions) {
    this.calls = buildCallLog(opts);
    this.channel = new SocketChannel({
      socketPath: opts.socketPath,
      label: 'MCP desktop channel',
      exclusive: true,
      dispatch: (token, connectionId, frame) => this.dispatch(token, connectionId, frame),
      closed: (_token, connectionId) => this.release(connectionId),
      errors: opts.errors,
    });
  }

  async listen(): Promise<boolean> {
    if (this.token) return true;
    if (!(await this.channel.listen())) return false;
    const token = randomUUID();
    if (!this.writeCredential(token)) {
      await this.channel.close();
      return false;
    }
    this.token = token;
    return true;
  }

  async close(): Promise<void> {
    this.token = null;
    this.sessions.clear();
    await this.channel.close();
    try {
      rmSync(this.opts.credentialPath, { force: true });
    } catch {
      /* already gone */
    }
  }

  session(connectionId: string = randomUUID()): {
    call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
    list(): Promise<string[]>;
    end(): void;
  } | null {
    const token = this.token;
    if (token === null) return null;
    return {
      call: async (name, args) => {
        const response = await this.dispatch(token, connectionId, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        });
        const result = response?.result as ToolCallResult | undefined;
        if (result) return result;
        return { content: [{ type: 'text', text: response?.error?.message ?? 'no response' }], isError: true };
      },
      list: async () => {
        const response = await this.dispatch(token, connectionId, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const result = response?.result as { tools?: { name: string }[] } | undefined;
        return (result?.tools ?? []).map((t) => t.name);
      },
      end: () => this.release(connectionId),
    };
  }

  registration(): { command: string; args: string[] } {
    return { command: process.execPath, args: [BRIDGE_PATH, '--desktop'] };
  }

  /**
   * Where the credential lives, for the operator-facing note. Public because the
   * only readers are outside this class.
   *
   * @public read by `system.ts` when it writes the skill.
   */
  credentialPath(): string {
    return this.opts.credentialPath;
  }

  /**
   * Whether the channel is up. The cockpit's MCP tab says so rather than handing
   * over a registration that would connect to nothing — or, on the one failure
   * this channel has, to the *other* harness holding the stable socket.
   *
   * @public read by the `/api/mcp` route.
   */
  running(): boolean {
    return this.token !== null;
  }

  /**
   * What `tools/list` would answer, for the operator-facing note. Built from the
   * live registry rather than listed again in the cockpit: a fourth tool, or a
   * reworded description, would otherwise be advertised in one place and
   * described in another.
   *
   * The session handed in is a throwaway — nothing here reads a claim, and a real
   * one would put this call in the per-connection map for no reason.
   *
   * @public read by the `/api/mcp` route.
   */
  advertised(): { name: string; description: string }[] {
    return buildDesktopTools(this.opts, { label: '', held: null }).map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  }

  private writeCredential(token: string): boolean {
    try {
      mkdirSync(dirname(this.opts.credentialPath), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.opts.credentialPath,
        JSON.stringify({ lubbdubb: 1, socket: this.opts.socketPath, token }, null, 2),
        { mode: 0o600 },
      );
      return true;
    } catch (err) {
      this.opts.errors?.record({
        source: 'agent',
        message: `MCP desktop channel not started: could not write ${this.opts.credentialPath} — ${(err as Error).message}`,
      });
      return false;
    }
  }

  private sessionFor(connectionId: string): DesktopSession {
    const existing = this.sessions.get(connectionId);
    if (existing) return existing;
    const session: DesktopSession = { label: defaultClaimLabel(), held: null };
    this.sessions.set(connectionId, session);
    return session;
  }

  private release(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    this.sessions.delete(connectionId);
    if (!session?.held) return;
    try {
      this.opts.store.releaseValidationClaim(session.held.originRef, session.held.checkId);
    } catch (err) {
      this.opts.errors?.record({
        source: 'agent',
        message: `Could not release a desktop validation claim: ${(err as Error).message}`,
      });
    }
  }

  private async dispatch(token: string, connectionId: string, frame: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const call = this.calls.callOf(frame);
    const startedAt = Date.now();
    if (!this.tokenMatches(token)) {
      if (frame.method === 'tools/call') {
        const stale =
          'This credential is not the one this harness is listening for. It is written fresh at every start, ' +
          `so re-reading ${this.opts.credentialPath} is all that is needed — the MCP registration itself ` +
          'does not change.';
        if (call !== null) {
          this.calls.record({
            channel: 'desktop',
            tool: call.tool,
            agentId: null,
            taskId: null,
            originRef: null,
            ok: false,
            error: stale,
            durationMs: Date.now() - startedAt,
            args: call.args,
          });
        }
        return { jsonrpc: '2.0', id: frame.id ?? null, result: toolError(stale) };
      }
      return await handleRequest(frame, []);
    }
    const response = await handleRequest(frame, buildDesktopTools(this.opts, this.sessionFor(connectionId)));
    if (call !== null) {
      const refusal = this.calls.refusalOf(response);
      this.calls.record({
        channel: 'desktop',
        tool: call.tool,
        agentId: null,
        taskId: null,
        originRef: null,
        ok: refusal === null,
        error: refusal,
        durationMs: Date.now() - startedAt,
        args: call.args,
      });
    }
    return response;
  }

  private tokenMatches(candidate: string): boolean {
    if (this.token === null) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    // TECHDEBT: `timingSafeEqual` throws on a length mismatch, which is itself a leak-free
    // answer: the token is a fixed-length uuid, so a different length is wrong.
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function defaultClaimLabel(): string {
  try {
    return `desktop (${hostname()})`;
  } catch {
    return 'desktop';
  }
}
