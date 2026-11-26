import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { resolve } from 'node:path';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import type { AppState } from '../web/src/types.js';

// → docs/spec/19-development.md#the-demo-cockpit

const FIXTURES = resolve(import.meta.dirname, '../test/support/cockpitFixtures.ts');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type FixtureModule = { buildFixtureState: () => AppState };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function demoState(vite: ViteDevServer): Promise<AppState> {
  const { buildFixtureState } = (await vite.ssrLoadModule(FIXTURES)) as FixtureModule;
  return buildFixtureState();
}

function demoApi(vite: ViteDevServer) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? '/', 'http://demo');
    if (!url.pathname.startsWith('/api/')) return next();
    if (req.method !== 'GET') {
      send(res, 409, { error: 'Demo cockpit — nothing is saved. Edit test/support/cockpitFixtures.ts instead.' });
      return;
    }
    if (url.pathname !== '/api/state') {
      send(res, 404, { error: `The demo world has no data for ${url.pathname}` });
      return;
    }
    demoState(vite).then(
      (state) => send(res, 200, state),
      (err: unknown) => {
        vite.ssrFixStacktrace(err as Error);
        send(res, 500, { error: `Building the demo world failed: ${(err as Error).message}` });
      },
    );
  };
}

function acceptSocket(req: IncomingMessage, socket: Duplex): void {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') return void socket.destroy();
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.resume();
  socket.on('error', () => socket.destroy());
}

const demoPlugin: Plugin = {
  name: 'lubbdubb-demo',
  configureServer(vite) {
    vite.middlewares.use(demoApi(vite));
    vite.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      if (new URL(req.url ?? '/', 'http://demo').pathname === '/ws') acceptSocket(req, socket);
    });
    vite.watcher.add(FIXTURES);
    vite.watcher.on('change', (file) => {
      if (file === FIXTURES) vite.ws.send({ type: 'full-reload' });
    });
  },
};

const vite = await createServer({
  configFile: resolve(import.meta.dirname, '../web/vite.config.ts'),
  mode: 'demo',
  plugins: [demoPlugin],
});
await vite.listen();
vite.printUrls();
console.log('[demo] the cockpit is showing the Inkwell Books fixture world — no harness behind it');
