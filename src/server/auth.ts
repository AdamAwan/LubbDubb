import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Local access control for the cockpit's HTTP/WebSocket surface — no identity
 * provider. Three layers: loopback binding (`config.host`), a bearer token attached
 * by hand and never a cookie (unforgeable cross-origin, so no CSRF token needed),
 * and Host/Origin checks as depth against DNS rebinding. The verdict is a pure
 * function ({@link authorizeRequest}) with the Fastify hook as a thin adapter.
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
 * 32 bytes of CSPRNG, base64url — 256 bits. Not a UUID like the MCP channel's:
 * this one is reachable by anyone who can open a socket, so it is sized for that.
 */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The token for this run, in precedence order: `LUBBDUBB_TOKEN`, then the token
 * file, then a freshly minted one persisted at 0600. Never a config-file key —
 * `Config` carries no secrets by rule, since `lubbdubb.config.json` is what an
 * operator pastes for help. The token file lives under the gitignored `.lubbdubb/`.
 */
export function resolveCockpitToken(tokenFile: string): CockpitToken {
  const fromEnv = process.env.LUBBDUBB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env', path: null };

  const path = resolve(process.cwd(), tokenFile);
  // Read and catch rather than check-then-use, which a hostile local process could
  // race. An empty or truncated file is a half-finished write, not a token — re-mint.
  const existing = readTokenFile(path);
  if (existing) return { token: existing, source: 'file', path };

  const token = mintToken();
  mkdirSync(dirname(path), { recursive: true });
  // Remove first so the write always *creates*: `mode` is honoured only on creation,
  // so writing into a pre-existing file could leave the token world-readable.
  rmSync(path, { force: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return { token, source: 'minted', path };
}

/** The token on disk, or null if there isn't one worth using (missing, empty, unreadable). */
function readTokenFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
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
   * Refuse a non-loopback `Host`. True when bound to loopback, where any other name
   * is a rebinding attempt; false when the operator bound a routable address.
   */
  requireLoopbackHost: boolean;
  /** Whether this caller has already spent its failure budget — see {@link createAuthThrottle}. */
  throttled: boolean;
}

type AuthVerdict = { ok: true } | { ok: false; code: 401 | 403 | 429; error: string };

/**
 * Which paths the token guards: the whole API and the live socket. The SPA shell
 * is deliberately **open** — the token arrives in the URL fragment, which a browser
 * never sends, so the page must load before it can authenticate; it holds no world
 * state. Matching by prefix guards a route added later by construction, which
 * `test/cockpitAuth.test.ts` asserts by walking the route table.
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
 * Any loopback origin passes, not just the one we serve from: `npm run web:dev`
 * proxies from Vite on another port. Every loopback origin is already this machine.
 */
function isLoopbackOrigin(origin: string): boolean {
  // `null` is what a sandboxed iframe sends, including the agent-authored artifact
  // route. Never a legitimate caller.
  if (origin === 'null') return false;
  try {
    return isLoopbackHostname(hostnameOf(new URL(origin).host));
  } catch {
    return false;
  }
}

/**
 * An origin whose authority is the request's own host — what a browser sends when
 * the operator bound a routable address, and the shape the loopback-only rule would
 * otherwise refuse. The port is part of the comparison.
 */
function isSameOriginAsHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host.trim().toLowerCase();
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

/**
 * Where a presented credential came from — `none` and `malformed` carry no token.
 * Reported alongside it so the log line cannot contradict the verdict beside it.
 */
type CredentialChannel = 'bearer' | 'query' | 'malformed' | 'none';

/**
 * The presented credential: `Authorization: Bearer <token>`, or `?t=` for the
 * WebSocket. Parsed by hand, never with a regex — the header is unauthenticated
 * attacker input, and `/^Bearer +(.+)$/i` backtracks polynomially on spaces.
 */
function presentedToken(req: AuthRequest): { token?: string; channel: CredentialChannel } {
  const header = req.authorization?.trim();
  if (header) {
    const space = header.indexOf(' ');
    if (space > 0 && header.slice(0, space).toLowerCase() === 'bearer') {
      const value = header.slice(space + 1).trim();
      if (value) return { token: value, channel: 'bearer' };
    }
    // A present-but-unusable header is its own diagnosis, not folded into `none`.
    // A junk header does not make a valid `?t=` invalid.
    if (req.queryToken) return { token: req.queryToken, channel: 'query' };
    return { channel: 'malformed' };
  }
  if (req.queryToken) return { token: req.queryToken, channel: 'query' };
  return { channel: 'none' };
}

/**
 * A refused request, described for the operator's log. It prints the presence and
 * channel of the credential, **never its value**, which is what separates a stale
 * `web/dist` (`credential=none`) from a wrong token. Every value is an
 * attacker-controlled header, so the caller encodes the result before logging it.
 */
export function describeAuthAttempt(req: AuthRequest): string {
  const path = req.url.split('?')[0] ?? req.url;
  return [
    `path=${path}`,
    `credential=${presentedToken(req).channel}`,
    `host=${req.host ?? '(absent)'}`,
    `origin=${req.origin ?? '(absent)'}`,
  ].join(' ');
}

/**
 * The next thing to try, when the refusal implies one — else null. Only `none` gets
 * a hint; a refusal that carried a credential is a token problem. Derived from the
 * same {@link presentedToken} the verdict used, so it cannot contradict it.
 */
export function authRefusalHint(req: AuthRequest): string | null {
  if (presentedToken(req).channel !== 'none') return null;
  return (
    'The client sent no credential at all, so the token is not the problem. ' +
    'Most often that is a stale web/dist — a cockpit bundle built before the token guard existed ' +
    'attaches no Authorization header and no ?t= to the socket. Rebuild it: npm run web:build.'
  );
}

/** How many refusals from one source, within {@link FAILURE_WINDOW_MS}, before it is shut out. */
const FAILURE_LIMIT = 20;
const FAILURE_WINDOW_MS = 60_000;
/** Cap on tracked sources, so a spray from many addresses can't grow the map without bound. */
const MAX_TRACKED_SOURCES = 4096;

interface AuthThrottle {
  /** Whether this source has spent its failure budget and should be refused unread. */
  blocked(key: string, now: number): boolean;
  /** Record a refusal. */
  fail(key: string, now: number): void;
}

/**
 * The throttle is asked and updated by the hook, never by {@link authorizeRequest},
 * which takes the answer as a plain `throttled` boolean — that is what keeps the
 * verdict a pure function of its inputs.
 */

/**
 * A sliding-window failure counter for the guard. **Only refusals are counted**,
 * never successful requests, so a working cockpit can never throttle itself. It
 * bounds the cost of hammering the port; the token's 256 bits are what make it
 * unguessable.
 */
export function createAuthThrottle(limit = FAILURE_LIMIT, windowMs = FAILURE_WINDOW_MS): AuthThrottle {
  const failures = new Map<string, number[]>();
  const live = (key: string, now: number): number[] => (failures.get(key) ?? []).filter((at) => now - at < windowMs);

  return {
    blocked: (key, now) => live(key, now).length >= limit,
    fail(key, now) {
      // Drop expired entries before growing past the cap, so the map is bounded by
      // active sources rather than by every address ever seen.
      if (failures.size >= MAX_TRACKED_SOURCES) {
        for (const [tracked] of failures) if (live(tracked, now).length === 0) failures.delete(tracked);
      }
      failures.set(key, [...live(key, now), now]);
    },
  };
}

/**
 * The guard's whole sequence: ask the throttle, decide, and count the refusal.
 * The order is the property — a `429` must **not** be counted, or a client that
 * keeps asking renews its own block forever, even with a correct token. The block
 * is in-process, so a restart clears it.
 */
export function guardRequest(
  attempt: AuthRequest,
  opts: { token: string; requireLoopbackHost: boolean; throttle: AuthThrottle; key: string; now: number },
): AuthVerdict {
  const throttled = opts.throttle.blocked(opts.key, opts.now);
  const verdict = authorizeRequest(attempt, {
    token: opts.token,
    requireLoopbackHost: opts.requireLoopbackHost,
    throttled,
  });
  if (!verdict.ok && !throttled) opts.throttle.fail(opts.key, opts.now);
  return verdict;
}

/**
 * The whole access decision, as a value. Order matters: origin and host are
 * answered **before** the token, so a leaked token never turns a rebinding or
 * cross-origin request into a way in, and the 403 names the true reason.
 */
export function authorizeRequest(req: AuthRequest, policy: AuthPolicy): AuthVerdict {
  if (!isGuardedPath(req.url)) return { ok: true };

  if (policy.throttled) return { ok: false, code: 429, error: 'too many failed attempts' };

  if (policy.requireLoopbackHost && !isLoopbackHostname(hostnameOf(req.host ?? ''))) {
    return { ok: false, code: 403, error: 'host not allowed' };
  }
  // A missing Origin is fine and common (curl, non-browser clients): its absence is
  // not a claim, and the token is what authenticates. A *present* Origin must be
  // loopback or the request's own host; anything else is a cross-site page.
  const sameOrigin = req.origin !== undefined && isSameOriginAsHost(req.origin, req.host);
  if (req.origin !== undefined && !isLoopbackOrigin(req.origin) && !sameOrigin) {
    return { ok: false, code: 403, error: 'cross-origin request refused' };
  }
  if (!tokenMatches(policy.token, presentedToken(req).token)) {
    return { ok: false, code: 401, error: 'missing or invalid cockpit token' };
  }
  return { ok: true };
}
