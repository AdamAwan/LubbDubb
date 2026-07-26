import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A capability to open **one** flagged artifact by a top-level browser navigation.
 *
 * **Why a second credential exists at all.** The artifact route is reached by a
 * navigation — the operator clicks a chip and a new tab opens on
 * `/artifacts/<id>`. A navigation cannot carry an `Authorization` header; only
 * `fetch`/XHR can. So the cockpit's bearer token, which {@link ../../web/src/api.ts}
 * attaches by hand to every `fetch`, structurally cannot reach this route, and the
 * `/api` prefix guard would refuse the navigation with a 401 (issue #129). The fix
 * is a different, deliberately weaker credential the navigation *can* carry — in
 * the query string, because a navigation has nowhere else to put it.
 *
 * **This is not the cockpit token in a query string.** The cockpit token stays in
 * the `#t=` fragment a browser never sends to a server, precisely so it cannot land
 * in an access log, a `Referer` or a proxy trace. Putting *it* in a URL would undo
 * that. A capability is a different thing:
 *
 * - **Flag-scoped.** The signature covers the flag id, and the route checks the id
 *   in its own path against it. A capability for one artifact cannot open another,
 *   and cannot be replayed against `/api/state` or `/api/jobs` — those routes
 *   accept only the bearer token, which this is not.
 * - **Short-lived.** An expiry is embedded and the verifier enforces it, so a
 *   capability that does leak (an access log, or agent-authored HTML reading its
 *   own `location`) is dead in minutes rather than being a standing key. Even
 *   before it expires, a leak buys nothing but re-reading the one artifact the
 *   holder was already looking at.
 * - **Stateless.** It is an HMAC over `<id>.<expiry>`, so nothing is stored: no map
 *   to leak, evict, race or grow without bound.
 *
 * The signing key is a fresh per-run secret (see `buildApp`), never the cockpit
 * token, so a capability is not the cockpit token even in a derived form.
 */
function sign(secret: Buffer, flagId: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(`${flagId}.${expiresAt}`).digest('base64url');
}

/** Mint a capability for `flagId` valid until `expiresAt` (epoch ms). */
export function mintArtifactCapability(secret: Buffer, flagId: string, expiresAt: number): string {
  return `${expiresAt}.${sign(secret, flagId, expiresAt)}`;
}

/**
 * Whether `token` is a live capability for `flagId`. False for a wrong signature, a
 * mismatched flag id, a malformed token, or one whose embedded expiry is at or
 * before `now`. The flag id is *not* carried in the token — it comes from the
 * request path — so a valid signature over a different id fails the recompute here.
 */
export function verifyArtifactCapability(secret: Buffer, token: string, flagId: string, now: number): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || now >= expiresAt) return false;
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, flagId, expiresAt));
  // Length is checked first: timingSafeEqual throws on unequal-length buffers, and
  // a base64url signature of the wrong length is not this signature regardless.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
