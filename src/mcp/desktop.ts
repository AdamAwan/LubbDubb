import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorRecorder } from '../errorLog.js';
import {
  handleRequest,
  toolError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolCallResult,
} from './protocol.js';
import { SocketChannel } from './socketChannel.js';
import { buildDesktopTools, type DesktopSession, type DesktopToolDeps } from './desktopTools.js';

/** Absolute path to the shipped stdio bridge. `--desktop` makes it read the credential file. */
const BRIDGE_PATH = fileURLToPath(new URL('./bridge.mjs', import.meta.url));

interface McpDesktopServerOptions extends DesktopToolDeps {
  socketPath: string;
  /** Where the credential is written, 0600. */
  credentialPath: string;
  errors?: ErrorRecorder;
}

/**
 * The desktop tool channel: a second MCP socket the operator's **own** Claude
 * Code connects to, so a validation check that needs a browser and a login the
 * fleet does not have can be run at their keyboard and land on the same row.
 *
 * ## What makes it different from the fleet channel
 *
 * **Identity has no agent behind it.** The fleet's is `token -> agent -> task ->
 * origin`, and every fence it draws is taken from that origin. Nobody dispatched
 * a desktop session, so there is no task and no origin, and the equivalent is
 * `token -> connection -> claim`: a session takes one check before it runs it,
 * and that claim is what a report is recorded against. Same shape, same
 * guarantee — which check a report is about is settled before the report rather
 * than by it.
 *
 * **The credential is long-lived and the socket path is stable.** That is the
 * whole feature: `claude mcp add` once, not once per run. The token still never
 * appears in the registration — the bridge reads it from a 0600 file at spawn —
 * so the command an operator pastes carries no secret, and a rotated token needs
 * no re-registration.
 *
 * **The tool set is three tools, narrowed by construction.** See
 * `src/mcp/desktopTools.ts`: this server never reaches `buildTools`, so there is
 * no path from a desktop connection to the rest of the harness.
 *
 * ## Fail open, as everywhere
 *
 * If the socket cannot be bound or the credential cannot be written, {@link
 * listen} returns false and nothing else changes: the fleet runs exactly as it
 * does, checks stay with whoever they were with, and the operator's Claude simply
 * finds no server. Nothing in the harness is gated on this channel existing.
 */
export class McpDesktopServer {
  private readonly channel: SocketChannel;
  /** Minted at {@link listen}, never configured. Null while the channel is down. */
  private token: string | null = null;
  private readonly sessions = new Map<string, DesktopSession>();

  constructor(private readonly opts: McpDesktopServerOptions) {
    this.channel = new SocketChannel({
      socketPath: opts.socketPath,
      label: 'MCP desktop channel',
      // Stable path: a live socket on it belongs to another harness, and taking
      // it would silently steal every future desktop session from a running one.
      exclusive: true,
      dispatch: (token, connectionId, frame) => this.dispatch(token, connectionId, frame),
      closed: (_token, connectionId) => this.release(connectionId),
      errors: opts.errors,
    });
  }

  /**
   * Start listening and write the credential. False means the channel is off —
   * the operator is told through the error log, and nothing else is affected.
   *
   * The token is minted here rather than read back from an existing credential,
   * so a credential from a previous run stops working the moment this one starts.
   * Nothing depends on it being stable: the bridge reads the file at every spawn.
   */
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

  /** Stop listening, drop every session, and remove the credential. */
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

  /**
   * An in-process caller for one desktop connection, or null while the channel
   * is down. The socket path and this one converge on {@link dispatch}, so a test
   * drives exactly the code the operator's bridge reaches — there is no
   * test-only tool path, which is the fleet channel's rule and its reason.
   *
   * `end()` is what the socket's close handler does, so the claim-release
   * behaviour under test is the behaviour in production.
   */
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

  /** The `claude mcp add-json` payload for this channel — what the skill's install note quotes. */
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

  /**
   * The credential the bridge reads. 0600 for the fleet launch config's reason:
   * the token is a bearer credential, and a file is why it never has to appear in
   * argv where `ps` would show it.
   */
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

  /** One connection's state, created on first use. */
  private sessionFor(connectionId: string): DesktopSession {
    const existing = this.sessions.get(connectionId);
    if (existing) return existing;
    const session: DesktopSession = { label: defaultClaimLabel(), held: null };
    this.sessions.set(connectionId, session);
    return session;
  }

  /**
   * A session ended. Its claim goes with it — closing the terminal is the normal
   * way a desktop run ends, and a claim that outlived it would hold the
   * operator's one-at-a-time budget against a session that no longer exists.
   *
   * The expiry in `claimStaleBefore` is the backstop for the case this cannot
   * cover: a harness killed between the claim and the close.
   */
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

  /** Answer one frame. Everything above the token check is the tools' business. */
  private async dispatch(token: string, connectionId: string, frame: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (!this.tokenMatches(token)) {
      // `initialize` and `tools/list` are still answered, with an empty tool set,
      // so a stale registration completes its handshake and reports a server with
      // no tools rather than hanging. Only a call needs a real credential.
      if (frame.method === 'tools/call') {
        return {
          jsonrpc: '2.0',
          id: frame.id ?? null,
          result: toolError(
            'This credential is not the one this harness is listening for. It is written fresh at every start, ' +
              `so re-reading ${this.opts.credentialPath} is all that is needed — the MCP registration itself ` +
              'does not change.',
          ),
        };
      }
      return await handleRequest(frame, []);
    }
    return await handleRequest(frame, buildDesktopTools(this.opts, this.sessionFor(connectionId)));
  }

  /** Constant-time, because this is the only thing between a local process and the store. */
  private tokenMatches(candidate: string): boolean {
    if (this.token === null) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    // `timingSafeEqual` throws on a length mismatch, which is itself a leak-free
    // answer: the token is a fixed-length uuid, so a different length is wrong.
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/**
 * What a claim is labelled when the session does not name itself. The machine,
 * because that is what an operator glancing at the cockpit needs in order to know
 * whether the thing holding a check is theirs.
 */
function defaultClaimLabel(): string {
  try {
    return `desktop (${hostname()})`;
  } catch {
    return 'desktop';
  }
}
