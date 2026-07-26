import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Local access control for the cockpit's HTTP/WebSocket surface.
 *
 * **Why there is any.** The surface is 17 mutating routes, and `POST /api/jobs`
 * is the one that sets the severity: an arbitrary prompt that rule 0 dispatches
 * ahead of every world-driven rule, spawning a real agent under
 * `agentPermissionMode` in a worktree of the operator's repo, inheriting the
 * launching shell's environment. Unauthenticated on `0.0.0.0` that is remote
 * code execution for anyone sharing the network, with repo write and a billing
 * side-effect attached. The MCP channel already reached this conclusion for
 * itself (see {@link ../mcp/server.ts}) — a Unix socket with a bearer token,
 * chosen *because* this surface had none. This closes the other half.
 *
 * **Three layers, no dependency.** Everything here is `node:crypto` plus header
 * parsing, because a local tool that needs an identity provider to be safe has
 * bought a service, not security:
 *
 * 1. **Loopback binding** (`config.host`, see `main.ts`) removes the network
 *    entirely, and is the only layer that helps against a peer who never speaks
 *    HTTP to us at all.
 * 2. **A bearer token** — the layer that actually authenticates. Held in the
 *    cockpit's `localStorage` and attached by hand, *never* a cookie: a cookie is
 *    what the browser sends unbidden, which is the whole reason cookie auth needs
 *    a CSRF token bolted on. A header the page must set itself cannot be forged
 *    by a cross-origin page, so one mechanism closes both the network threat and
 *    the drive-by-browser threat.
 * 3. **Host and Origin checks** — defence in depth for DNS rebinding, where an
 *    attacker's page re-points its own name at `127.0.0.1` so that *its* origin
 *    is talking to *our* server. Layer 2 already defeats this (the attacker has
 *    no token, and origin-scoped storage means they cannot read ours), so this
 *    layer exists to make a token leak survivable rather than fatal.
 *
 * The verdict is a pure function ({@link authorizeRequest}) with the Fastify hook
 * as a thin adapter, so the interesting cases are unit tests rather than servers.
 */

/** Where the running token came from — reported in the startup banner, not a security input. */
type TokenSource = 'env' | 'file' | 'minted';

interface CockpitToken {
  token: string;
  source: TokenSource;
  /** Absolute path the token was read from or written to; null for the env token. */
  path: string | null;
}

/**
 * 32 bytes of CSPRNG, base64url — 256 bits, so there is nothing to say about
 * guessing it. Not a UUID: {@link ../mcp/server.ts} mints `randomUUID` for the
 * tool channel, which is 122 bits behind a filesystem-permission boundary an
 * attacker must already be inside. This one is reachable by anyone who can open
 * a socket, so it is sized for that instead of matched to the neighbour.
 */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The token for this run, in precedence order: `LUBBDUBB_TOKEN`, then the token
 * file, then a freshly minted one persisted to that file at 0600.
 *
 * **Deliberately not a config-file key.** `Config` carries no secrets by rule —
 * the `github` provider takes its token from `GITHUB_TOKEN` only, so that a
 * secret cannot be committed — and `lubbdubb.config.json` is the file an operator
 * is most likely to paste into an issue when asking for help. The token file is
 * separate, is 0600, and lives under the already-gitignored `.lubbdubb/`.
 *
 * **Minting is the default because the alternative is worse.** Requiring the
 * operator to invent and paste a token makes the secure path the inconvenient
 * one, and the predictable result is `auth.enabled: false`. It also buys nothing
 * real: the file is readable only by the user the harness runs as, and a process
 * running as that user can already read the SQLite store, the worktrees and the
 * environment — so there is no threat model in which a hand-typed token is
 * stronger than a minted one.
 */
export function resolveCockpitToken(tokenFile: string): CockpitToken {
  const fromEnv = process.env.LUBBDUBB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env', path: null };

  const path = resolve(process.cwd(), tokenFile);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    // An empty or truncated file is a half-finished write from a killed boot, not
    // a token — re-mint rather than run with a guessable credential.
    if (existing) return { token: existing, source: 'file', path };
  }

  const token = mintToken();
  mkdirSync(dirname(path), { recursive: true });
  // 0600 at creation, never chmod-ed afterwards: the mode argument applies only
  // when the file is created, and umask can only remove bits from it, so the
  // result is never looser than this.
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return { token, source: 'minted', path };
}

/** The request fields the guard reads. Keeps {@link authorizeRequest} free of Fastify. */
interface AuthRequest {
  /** Request URL including any query string. */
  url: string;
  host?: string;
  origin?: string;
  authorization?: string;
  /** `?t=` — the WebSocket's only channel, since browsers cannot set headers on it. */
  queryToken?: string;
}

interface AuthPolicy {
  token: string;
  /**
   * Refuse a non-loopback `Host`. True when the server is bound to loopback: the
   * only legitimate names for it are then loopback names, so anything else is a
   * rebinding attempt. False when the operator has deliberately bound a routable
   * address, where a LAN hostname is exactly what a legitimate client sends and
   * the token is carrying the security on its own.
   */
  requireLoopbackHost: boolean;
}

type AuthVerdict = { ok: true } | { ok: false; code: 401 | 403; error: string };

/**
 * Which paths the token guards: the whole API and the live socket.
 *
 * The SPA shell and its assets are deliberately **open**. They have to be — the
 * token arrives in the URL *fragment*, which a browser never sends to a server,
 * so the page must load before it can authenticate. Nothing is lost by it: the
 * shell is a static bundle holding no world state, and every byte of data it
 * renders comes from a guarded route.
 *
 * Matching by prefix rather than per-route is the point. A route added later is
 * guarded by construction instead of by the author remembering to opt in, which
 * is the property `test/cockpitAuth.test.ts` asserts by walking the route table.
 */
function isGuardedPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path === '/ws' || path === '/api' || path.startsWith('/api/');
}

/** The hostname of a `Host` header or an origin authority, minus port and IPv6 brackets. */
function hostnameOf(authority: string): string {
  const trimmed = authority.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? '' : trimmed.slice(1, end).toLowerCase();
  }
  const colon = trimmed.indexOf(':');
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
}

/**
 * Exact names only — `localhost`, the `127/8` block, and IPv6 `::1`. A suffix
 * match would accept `localhost.attacker.example`, which is precisely the name a
 * rebinding attacker controls.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Any loopback origin passes, not just the exact one we are serving from — the
 * dev setup proxies the cockpit from Vite on another port (`npm run web:dev`),
 * and http-proxy forwards that `Origin` verbatim. Pinning the port would break
 * development, and the distinction it would draw is not a security one: every
 * loopback origin is already this machine.
 */
function isLoopbackOrigin(origin: string): boolean {
  // `null` is what a sandboxed iframe sends — including the CSP-sandboxed
  // artifact route, whose content is agent-authored. Never a legitimate caller.
  if (origin === 'null') return false;
  try {
    return isLoopbackHostname(hostnameOf(new URL(origin).host));
  } catch {
    return false;
  }
}

/** Constant-time token comparison. A length mismatch is answered before `timingSafeEqual`, which throws on unequal buffers. */
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The presented credential: `Authorization: Bearer <token>`, or `?t=` for the WebSocket. */
function presentedToken(req: AuthRequest): string | undefined {
  const bearer = /^Bearer[ ]+(.+)$/i.exec(req.authorization?.trim() ?? '')?.[1];
  return bearer?.trim() ?? req.queryToken;
}

/**
 * The whole access decision, as a value.
 *
 * Order matters: origin and host are answered **before** the token. A rebinding
 * or cross-origin request is refused for what it is regardless of whether it
 * guessed a credential, so a leaked token never turns those into a way in — and
 * the operator reading a 403 gets the true reason rather than "unauthorized".
 */
export function authorizeRequest(req: AuthRequest, policy: AuthPolicy): AuthVerdict {
  if (!isGuardedPath(req.url)) return { ok: true };

  if (policy.requireLoopbackHost && !isLoopbackHostname(hostnameOf(req.host ?? ''))) {
    return { ok: false, code: 403, error: 'host not allowed' };
  }
  // A missing Origin is fine and common: curl, the smoke script and every
  // non-browser client omit it. Its absence is not a claim, so it is not refused
  // — the token is what authenticates. What is refused is an Origin that is
  // present and names somewhere else, which only a browser sends and which no
  // legitimate caller of a local cockpit ever is.
  if (req.origin !== undefined && !isLoopbackOrigin(req.origin)) {
    return { ok: false, code: 403, error: 'cross-origin request refused' };
  }
  if (!tokenMatches(policy.token, presentedToken(req))) {
    return { ok: false, code: 401, error: 'missing or invalid cockpit token' };
  }
  return { ok: true };
}
