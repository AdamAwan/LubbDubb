import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Local access control for the cockpit's HTTP/WebSocket surface.
 *
 * **Why there is any.** The surface is 17 mutating routes, and `POST /api/jobs`
 * is the one that sets the severity: an arbitrary prompt that rule `manual-job` dispatches
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
  // Read and catch rather than `existsSync` then read: the two-call form has a
  // window in which the file can vanish, which would throw out of a boot path,
  // and it is the check-then-use shape a hostile local process would race.
  // An empty or truncated file is a half-finished write from a killed boot, not
  // a token — re-mint rather than run with a guessable credential.
  const existing = readTokenFile(path);
  if (existing) return { token: existing, source: 'file', path };

  const token = mintToken();
  mkdirSync(dirname(path), { recursive: true });
  // Remove first so the write always *creates*. `mode` is honoured only on
  // creation, so writing into a pre-existing file — the empty-file case above
  // reaches exactly that — would keep whatever permissions it already had and
  // could leave the token world-readable. umask can only remove bits from 0600,
  // never add them, so the result is never looser than this.
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
   * Refuse a non-loopback `Host`. True when the server is bound to loopback: the
   * only legitimate names for it are then loopback names, so anything else is a
   * rebinding attempt. False when the operator has deliberately bound a routable
   * address, where a LAN hostname is exactly what a legitimate client sends and
   * the token is carrying the security on its own.
   */
  requireLoopbackHost: boolean;
  /** Whether this caller has already spent its failure budget — see {@link createAuthThrottle}. */
  throttled: boolean;
}

type AuthVerdict = { ok: true } | { ok: false; code: 401 | 403 | 429; error: string };

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

/**
 * Where a presented credential came from — `none` and `malformed` carry no token.
 * Reported alongside it so {@link describeAuthAttempt} can name the channel
 * without re-parsing the header: two parsers disagreeing about what the client
 * sent is the drift this codebase has paid for more than once, and here it would
 * mean a log line contradicting the verdict beside it.
 */
type CredentialChannel = 'bearer' | 'query' | 'malformed' | 'none';

/**
 * The presented credential: `Authorization: Bearer <token>`, or `?t=` for the
 * WebSocket.
 *
 * Parsed by hand rather than with `/^Bearer +(.+)$/i`. That pattern is
 * ambiguous — `.` matches a space too, so the two quantifiers can split a run of
 * spaces between them in many ways — which makes it backtrack polynomially on a
 * header of nothing but spaces. The header is unauthenticated attacker input, so
 * it is the one string here worth not handing to a regex engine at all.
 */
function presentedToken(req: AuthRequest): { token?: string; channel: CredentialChannel } {
  const header = req.authorization?.trim();
  if (header) {
    const space = header.indexOf(' ');
    if (space > 0 && header.slice(0, space).toLowerCase() === 'bearer') {
      const value = header.slice(space + 1).trim();
      if (value) return { token: value, channel: 'bearer' };
    }
    // A header that is present but unusable is its own diagnosis — a client
    // sending the wrong scheme is a different bug from one sending nothing — so
    // it is not folded into `none`. The query token is still honoured: the
    // header being junk does not make a valid `?t=` invalid.
    if (req.queryToken) return { token: req.queryToken, channel: 'query' };
    return { channel: 'malformed' };
  }
  if (req.queryToken) return { token: req.queryToken, channel: 'query' };
  return { channel: 'none' };
}

/**
 * A refused request, described for the operator's log — with nothing secret in it.
 *
 * This exists for one failure in particular, because it costs an afternoon: every
 * request 401ing and every WebSocket upgrade refused, on a machine where
 * restarting the server and hard-refreshing the browser change nothing. That is
 * what a stale `web/dist` looks like — a bundle built before the cockpit had
 * token support attaches no header at all — and from the server side it is
 * indistinguishable from a wrong token unless the log says *which*. So the fact
 * worth printing is the presence and channel of the credential, never its value:
 * `credential=none` on a guarded path names the client, while a mismatching
 * `credential=bearer` names the token.
 *
 * Every value here is an attacker-controlled header, so the caller encodes the
 * result before logging it — a newline in an `Origin` would otherwise forge a
 * second, fake log line.
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
 * The next thing to try, when the refusal implies one — else null.
 *
 * Only `none` gets a hint, and that is the point: a refusal that *did* carry a
 * credential is a token problem, and telling its operator to rebuild the cockpit
 * would send them somewhere the fault is not. Derived from the same
 * {@link presentedToken} the verdict used rather than by re-reading the string
 * {@link describeAuthAttempt} produced, so the hint cannot contradict the line it
 * is attached to.
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
 * which takes the answer as a plain `throttled` boolean. Keeping the state out of
 * the verdict is what leaves it a pure function of its inputs — the same split the
 * rest of the codebase draws between a predicate and the thing that calls it.
 */

/**
 * A sliding-window failure counter for the guard.
 *
 * **Only refusals are counted**, never successful requests — the cockpit polls
 * `/api/state` continuously, and throttling that is the thing
 * `@fastify/rate-limit`'s `global: false` registration exists to avoid. So a
 * working cockpit can never throttle itself no matter how busy it is.
 *
 * It is **not** what makes the token unguessable; 256 bits already does that, and
 * no feasible number of attempts moves that needle. What it bounds is the *cost*
 * of someone hammering the port — every attempt otherwise buys a routing pass and
 * a constant-time compare — and it turns a sustained guessing attempt into
 * something an operator can see in a log rather than something silent.
 */
export function createAuthThrottle(limit = FAILURE_LIMIT, windowMs = FAILURE_WINDOW_MS): AuthThrottle {
  const failures = new Map<string, number[]>();
  const live = (key: string, now: number): number[] => (failures.get(key) ?? []).filter((at) => now - at < windowMs);

  return {
    blocked: (key, now) => live(key, now).length >= limit,
    fail(key, now) {
      // Drop expired entries wholesale before growing past the cap, so the map is
      // bounded by active sources rather than by every address ever seen.
      if (failures.size >= MAX_TRACKED_SOURCES) {
        for (const [tracked] of failures) if (live(tracked, now).length === 0) failures.delete(tracked);
      }
      failures.set(key, [...live(key, now), now]);
    },
  };
}

/**
 * The guard's whole sequence: ask the throttle, decide, and count the refusal.
 *
 * One function rather than three lines in the hook, because the order of those
 * three lines is the property: a `429` is a refusal too, so counting it stamps a
 * fresh entry into the sliding window that produced it. The window then drains
 * only if the client **stops asking** — a cockpit reconnecting its socket every
 * eight seconds renews its own block forever, and once tripped a *correct* token
 * goes on renewing it. What the counter counts is refusals that read a
 * credential, which is what bounds the cost of guessing while leaving "wait out
 * the window" the escape it is documented to be.
 *
 * The block is in-process, so a restart clears it too.
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
 * The whole access decision, as a value.
 *
 * Order matters: origin and host are answered **before** the token. A rebinding
 * or cross-origin request is refused for what it is regardless of whether it
 * guessed a credential, so a leaked token never turns those into a way in — and
 * the operator reading a 403 gets the true reason rather than "unauthorized".
 */
export function authorizeRequest(req: AuthRequest, policy: AuthPolicy): AuthVerdict {
  if (!isGuardedPath(req.url)) return { ok: true };

  if (policy.throttled) return { ok: false, code: 429, error: 'too many failed attempts' };

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
  if (!tokenMatches(policy.token, presentedToken(req).token)) {
    return { ok: false, code: 401, error: 'missing or invalid cockpit token' };
  }
  return { ok: true };
}
