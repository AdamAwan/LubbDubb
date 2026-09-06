import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { ErrorRecorder } from '../errorLog.js';
import { debugLog } from '../debug.js';
import { parseFrame, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js';

// → docs/spec/11-mcp-tools.md

interface SocketChannelOptions {
  socketPath: string;
  label: string;
  exclusive: boolean;
  dispatch(token: string, connectionId: string, frame: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  closed?(token: string, connectionId: string): void;
  errors?: ErrorRecorder;
}

export class SocketChannel {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: SocketChannelOptions) {}

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
    server.on('error', () => {});
    this.server = server;
    debugLog('mcp', `${this.opts.label} listening on ${this.opts.socketPath}`);
    return true;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

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

  private async serve(socket: Socket, token: string, connectionId: string, line: string): Promise<void> {
    const frame = parseFrame(line);
    if (!frame) return;
    try {
      const response = await this.opts.dispatch(token, connectionId, frame);
      if (response) socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      this.opts.errors?.record({ source: 'agent', message: `MCP frame failed: ${(err as Error).message}` });
    }
  }
}

function handshakeToken(line: string): string | null {
  try {
    const value = JSON.parse(line) as { lubbdubb?: unknown; token?: unknown };
    if (value?.lubbdubb !== 1 || typeof value.token !== 'string' || !value.token) return null;
    return value.token;
  } catch {
    return null;
  }
}
