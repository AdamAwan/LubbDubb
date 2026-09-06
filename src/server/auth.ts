import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// → docs/spec/16-http-api.md

type TokenSource = 'env' | 'file' | 'minted';

interface CockpitToken {
  token: string;
  source: TokenSource;
  path: string | null;
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function resolveCockpitToken(tokenFile: string): CockpitToken {
  const fromEnv = process.env.LUBBDUBB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env', path: null };

  const path = resolve(process.cwd(), tokenFile);
  const existing = readTokenFile(path);
  if (existing) return { token: existing, source: 'file', path };

  const token = mintToken();
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return { token, source: 'minted', path };
}

function readTokenFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

interface AuthRequest {
  url: string;
  host?: string;
  origin?: string;
  authorization?: string;
  queryToken?: string;
}

interface AuthPolicy {
  token: string;
  requireLoopbackHost: boolean;
  throttled: boolean;
}

type AuthVerdict = { ok: true } | { ok: false; code: 401 | 403 | 429; error: string };

function isGuardedPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path === '/ws' || path === '/api' || path.startsWith('/api/');
}

function hostnameOf(authority: string): string {
  const trimmed = authority.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? '' : trimmed.slice(1, end).toLowerCase();
  }
  const colon = trimmed.indexOf(':');
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isLoopbackOrigin(origin: string): boolean {
  if (origin === 'null') return false;
  try {
    return isLoopbackHostname(hostnameOf(new URL(origin).host));
  } catch {
    return false;
  }
}

function isSameOriginAsHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type CredentialChannel = 'bearer' | 'query' | 'malformed' | 'none';

function presentedToken(req: AuthRequest): { token?: string; channel: CredentialChannel } {
  const header = req.authorization?.trim();
  if (header) {
    const space = header.indexOf(' ');
    if (space > 0 && header.slice(0, space).toLowerCase() === 'bearer') {
      const value = header.slice(space + 1).trim();
      if (value) return { token: value, channel: 'bearer' };
    }
    if (req.queryToken) return { token: req.queryToken, channel: 'query' };
    return { channel: 'malformed' };
  }
  if (req.queryToken) return { token: req.queryToken, channel: 'query' };
  return { channel: 'none' };
}

export function describeAuthAttempt(req: AuthRequest): string {
  const path = req.url.split('?')[0] ?? req.url;
  return [
    `path=${path}`,
    `credential=${presentedToken(req).channel}`,
    `host=${req.host ?? '(absent)'}`,
    `origin=${req.origin ?? '(absent)'}`,
  ].join(' ');
}

export function authRefusalHint(req: AuthRequest): string | null {
  if (presentedToken(req).channel !== 'none') return null;
  return (
    'The client sent no credential at all, so the token is not the problem. ' +
    'Most often that is a stale web/dist — a cockpit bundle built before the token guard existed ' +
    'attaches no Authorization header and no ?t= to the socket. Rebuild it: npm run web:build.'
  );
}

const FAILURE_LIMIT = 20;
const FAILURE_WINDOW_MS = 60_000;
const MAX_TRACKED_SOURCES = 4096;

interface AuthThrottle {
  blocked(key: string, now: number): boolean;
  fail(key: string, now: number): void;
}

export function createAuthThrottle(limit = FAILURE_LIMIT, windowMs = FAILURE_WINDOW_MS): AuthThrottle {
  const failures = new Map<string, number[]>();
  const live = (key: string, now: number): number[] => (failures.get(key) ?? []).filter((at) => now - at < windowMs);

  return {
    blocked: (key, now) => live(key, now).length >= limit,
    fail(key, now) {
      if (failures.size >= MAX_TRACKED_SOURCES) {
        for (const [tracked] of failures) if (live(tracked, now).length === 0) failures.delete(tracked);
      }
      failures.set(key, [...live(key, now), now]);
    },
  };
}

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

export function authorizeRequest(req: AuthRequest, policy: AuthPolicy): AuthVerdict {
  if (!isGuardedPath(req.url)) return { ok: true };

  if (policy.throttled) return { ok: false, code: 429, error: 'too many failed attempts' };

  if (policy.requireLoopbackHost && !isLoopbackHostname(hostnameOf(req.host ?? ''))) {
    return { ok: false, code: 403, error: 'host not allowed' };
  }
  const sameOrigin = req.origin !== undefined && isSameOriginAsHost(req.origin, req.host);
  if (req.origin !== undefined && !isLoopbackOrigin(req.origin) && !sameOrigin) {
    return { ok: false, code: 403, error: 'cross-origin request refused' };
  }
  if (!tokenMatches(policy.token, presentedToken(req).token)) {
    return { ok: false, code: 401, error: 'missing or invalid cockpit token' };
  }
  return { ok: true };
}
