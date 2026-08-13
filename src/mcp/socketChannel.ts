import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { ErrorRecorder } from '../errorLog.js';
import { debugLog } from '../debug.js';
import { parseFrame, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js';

/**
 * The listening half of an MCP channel: a Unix domain socket (a named pipe on
 * Windows), a handshake that names the caller, and newline-delimited JSON-RPC
 * over it. Everything above the frames — which tools exist, who may call them —
 * belongs to whoever supplies {@link SocketChannelOptions.dispatch}.
 *
 * **Two channels share this, which is the reason it exists.** The fleet's server
 * and the desktop one are the same transport with different identity models, and
 * a second copy of the handshake would be a second place for "a connection that
 * did not identify itself gets nothing" to drift. That rule is the only thing
 * between a local process and the whole store, and it is now written once.
 *
 * **Never TCP.** The cockpit's HTTP surface is already unauthenticated on
 * `0.0.0.0`; a second one with write access to the store is not a trade worth
 * making, and a filesystem socket is reachable only by something already on the
 * machine and holding the token.
 */
interface SocketChannelOptions {
  socketPath: string;
  /**
   * What this channel is called in an error an operator reads. There are two of
   * them now, and "the socket could not be created" says nothing about which.
   */
  label: string;
  /**
   * How a path that is already in use is treated, and the difference is
   * load-bearing.
   *
   * `false` — the fleet socket, which carries the pid. Nobody else can want this
   * exact path, so a file sitting on it is debris from a crashed run and is
   * removed. Binding is the only way to tell a dead socket from a live one.
   *
   * `true` — the desktop socket, which is *stable* so that the MCP server can be
   * registered in Claude Code once. A live socket on it means another harness on
   * this machine already owns the operator's desktop registration, and unlinking
   * it would silently steal every future session from a running process. So a
   * live one is refused and only a dead one is cleared.
   */
  exclusive: boolean;
  /**
   * Answer one frame from a connection. `connectionId` is this socket's own, so a
   * caller can hold per-connection state (the desktop channel's claims) and clean
   * it up in {@link SocketChannelOptions.closed}.
   */
  dispatch(token: string, connectionId: string, frame: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  /** One connection ended. Only fires for a connection that completed its handshake. */
  closed?(token: string, connectionId: string): void;
  errors?: ErrorRecorder;
}

export class SocketChannel {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: SocketChannelOptions) {}

  /**
   * Start listening. **Best-effort by contract**: a false return means this
   * channel is off, not that anything failed — the fleet falls back to sentinels
   * and the desktop registration simply finds nothing to connect to. Nothing here
   * is on the critical path of an agent finishing its work.
   */
  async listen(): Promise<boolean> {
    if (this.server) return true;
    if (!(await this.clearPath())) return false;
    const server = createServer((socket) => this.accept(socket));
    const started = await new Promise<boolean>((resolve) => {
      server.once('error', (err: Error) => {
        this.opts.errors?.record({ source: 'agent', message: `${this.opts.label} unavailable: ${err.message}` });
        resolve(false);
      });
      server.listen(this.opts.socketPath, () => resolve(true));
    });
    if (!started) return false;
    // A listener must never take the process down; a dropped connection is routine.
    server.on('error', () => {});
    this.server = server;
    debugLog('mcp', `${this.opts.label} listening on ${this.opts.socketPath}`);
    return true;
  }

  /** Stop listening and drop every live connection. */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Make the path bindable, or refuse. Windows named pipes have no filesystem
   * entry to clear, so they short-circuit.
   */
  private async clearPath(): Promise<boolean> {
    if (this.opts.socketPath.startsWith('\\\\')) return true;
    if (!this.opts.exclusive) {
      try {
        rmSync(this.opts.socketPath, { force: true });
      } catch {
        /* nothing to clear */
      }
      return true;
    }
    if (await this.someoneAnswers()) {
      this.opts.errors?.record({
        source: 'agent',
        message:
          `${this.opts.label} not started: another LubbDubb is already listening on ${this.opts.socketPath}. ` +
          `Only one harness can own the desktop registration on a machine — stop the other one, or point this ` +
          `deployment at a different validation.desktopSocketPath.`,
      });
      return false;
    }
    try {
      rmSync(this.opts.socketPath, { force: true });
    } catch {
      /* nothing to clear */
    }
    return true;
  }

  /** Whether something live is on the path — the only way to tell debris from an owner. */
  private someoneAnswers(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const probe = connect(this.opts.socketPath);
      const done = (answer: boolean): void => {
        probe.destroy();
        resolve(answer);
      };
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
    });
  }

  /** One connection: a handshake line, then newline-delimited JSON-RPC. */
  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    const connectionId = randomUUID();
    let buffer = '';
    let token: string | null = null;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (token !== null) this.opts.closed?.(token, connectionId);
    });
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
          // the only thing standing between a local process and the whole store.
          if (token === null) {
            socket.destroy();
            return;
          }
          continue;
        }
        void this.serve(socket, token, connectionId, line);
      }
    });
  }

  /** Handle one frame, writing the response back if there is one. */
  private async serve(socket: Socket, token: string, connectionId: string, line: string): Promise<void> {
    const frame = parseFrame(line);
    if (!frame) return; // unparsable noise; a notification-shaped frame takes no reply either
    try {
      const response = await this.opts.dispatch(token, connectionId, frame);
      if (response) socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      // Never let one bad frame kill the channel for the rest of the session.
      this.opts.errors?.record({ source: 'agent', message: `MCP frame failed: ${(err as Error).message}` });
    }
  }
}

/** The token from a connection's opening handshake line, or null if it isn't one. */
function handshakeToken(line: string): string | null {
  try {
    const value = JSON.parse(line) as { lubbdubb?: unknown; token?: unknown };
    if (value?.lubbdubb !== 1 || typeof value.token !== 'string' || !value.token) return null;
    return value.token;
  } catch {
    return null;
  }
}
