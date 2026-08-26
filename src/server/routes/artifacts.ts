import type { FastifyInstance } from 'fastify';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { mintArtifactCapability, verifyArtifactCapability } from '../artifactCapability.js';
import { checked, IdParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * Serving a local file the cockpit may look at — one an agent flagged, or one an
 * operator attached to a brief — and the capability that authorizes it.
 *
 * The two routes share a shape because they share a problem: both are reached by
 * the browser *without* the cockpit's bearer token (a navigation for the first, an
 * `<img>` load for the second), so both sit outside the `/api` prefix guard and
 * carry a short-lived, per-subject capability instead.
 */
export function register(app: FastifyInstance, { system, artifactKey }: RouteContext): void {
  const { store, config } = system;

  // Operator-configured absolute docsFolderPrefix entries are trusted roots this
  // route may serve from, on top of each agent's worktree. Relative entries add
  // nothing here — they're already covered by the worktree root.
  const artifactRoots = absolutePrefixes(config.docsFolderPrefix);

  // Serve a local artifact an agent flagged (a design doc, a report), addressed by
  // its flag id. The path is taken from the *stored* flag row, not the request, so
  // a client can only fetch a ref an agent actually surfaced — and the served path
  // is confined to that agent's worktree or an operator-configured absolute
  // `docsFolderPrefix` root (a symlink or `..` that escapes every root is refused).
  // The response is sandboxed (CSP `sandbox`) so agent-authored HTML can't script
  // the cockpit's origin. Rate-limited since it reads off disk. URL flags aren't
  // served here; the cockpit links those directly.
  //
  // **This route lives outside the `/api` prefix on purpose (issue #129).** It is
  // reached by a top-level browser navigation — the operator clicks a chip, a new
  // tab opens here — and a navigation cannot set an `Authorization` header, only
  // `fetch` can. So the cockpit's bearer token (attached by hand to every `fetch`,
  // held in a fragment the browser never sends) structurally cannot reach a route
  // under `/api`, and the prefix guard would 401 it. Rather than carve an exception
  // *into* the guard — which would erode "guarded by prefix, not per-route opt-in"
  // — the route sits outside the prefix and authorizes itself with a per-flag
  // capability the navigation can carry in the query string (see
  // {@link ./artifactCapability.ts} for why that is not the cockpit token in a URL).
  app.get(
    '/artifacts/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    checked({ params: IdParams }, async ({ params, req, reply }) => {
      const { id } = params;
      // Capability first, before the flag is even looked up: it is bound to this id,
      // and refusing early keeps the route from confirming which flag ids exist to a
      // caller that holds no capability. Skipped only when auth is off (no key).
      if (artifactKey) {
        const tk = (req.query as { tk?: unknown })?.tk;
        if (typeof tk !== 'string' || !verifyArtifactCapability(artifactKey, tk, id, Date.now()))
          return reply.code(401).send({ error: 'missing or invalid artifact capability' });
      }
      const flag = store.getFlag(id);
      if (!flag) return reply.code(404).send({ error: 'artifact not found' });
      if (/^https?:\/\//i.test(flag.ref))
        return reply.code(400).send({ error: 'url refs are linked directly, not served' });
      const agent = store.getAgent(flag.agentId);
      if (!agent) return reply.code(404).send({ error: 'agent not found' });
      const file = resolveConfinedArtifact(agent.cwd, flag.ref, artifactRoots);
      if (!file) return reply.code(404).send({ error: 'artifact not found' });
      reply
        .header('content-type', artifactMime(file))
        .header('content-security-policy', 'sandbox allow-scripts allow-downloads')
        .header('x-content-type-options', 'nosniff');
      return reply.send(readFileSync(file));
    }),
  );

  // Serve an image the operator attached to a brief (issue #249), addressed by
  // its attachment id. Outside `/api` for the artifact route's reason and one more:
  // this is loaded as an `<img src>`, a subresource fetch the browser makes on its
  // own, which can no more carry the cockpit's `Authorization` header than a
  // navigation can. So it authorizes itself with the same per-run capability,
  // minted per attachment into the state snapshot.
  //
  // The path comes from the *stored row*, never from the request, and is
  // re-confined to `attachmentRoot` before it is read — the same belt-and-braces
  // the artifact route applies to a flag's ref. Nothing but this harness writes
  // under that root, so the check has nothing to catch today; it is what keeps
  // that true if something ever does.
  app.get(
    '/attachments/:id',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    checked({ params: IdParams }, async ({ params, req, reply }) => {
      const { id } = params;
      if (artifactKey) {
        const tk = (req.query as { tk?: unknown })?.tk;
        if (typeof tk !== 'string' || !verifyArtifactCapability(artifactKey, tk, attachmentSubject(id), Date.now()))
          return reply.code(401).send({ error: 'missing or invalid attachment capability' });
      }
      const attachment = store.getAttachment(id);
      if (!attachment) return reply.code(404).send({ error: 'attachment not found' });
      const file = confinedTo(config.attachmentRoot, attachment.path);
      if (!file) return reply.code(404).send({ error: 'attachment not found' });
      reply
        // The stored mime, which was sniffed from the bytes rather than declared by
        // whoever uploaded them — with `nosniff`, so the browser does not go looking
        // for a second opinion. `sandbox` for the artifact route's reason: these
        // bytes came from outside the harness and are rendered on its own origin.
        .header('content-type', attachment.mime)
        .header('content-security-policy', 'sandbox')
        .header('x-content-type-options', 'nosniff')
        // Immutable: an attachment's bytes never change, and its id is minted with
        // them. It is worth setting because the URL is stable across polls (see
        // {@link attachmentSignerFor}); `private` because a capability URL must
        // never be held by a shared cache.
        .header('cache-control', 'private, max-age=300, immutable');
      return reply.send(readFileSync(file));
    }),
  );
}

/**
 * What an attachment capability is signed over. Namespaced so a capability minted
 * for a flag cannot open an attachment (or the reverse) even if the two id spaces
 * ever collided — free, and it means the two routes never have to reason about
 * each other's ids.
 */
function attachmentSubject(id: string): string {
  return `attachment:${id}`;
}

/**
 * Mint a capability into every attachment URL the state snapshot ships — the
 * `artifactSignerFor` of the route above, and deliberately the same key: both are
 * per-run, both are short-lived, and one secret with two subjects is less to get
 * wrong than two secrets.
 *
 * **The expiry is bucketed, unlike an artifact's.** An artifact URL is minted for
 * a click that may never come, so a fresh expiry every poll costs nothing. A
 * thumbnail is an `<img src>` the browser *is* loading, and a URL that changes on
 * every state poll is a URL the cache can never hit: the image would be re-fetched
 * every few seconds and flicker while it re-decoded. Rounding the expiry down to a
 * bucket makes the string identical across the polls inside one bucket, so the
 * browser's own cache does its job. The capability then lives between one and two
 * buckets rather than exactly one TTL, which is the same order of short.
 */
export function attachmentSignerFor(key: Buffer): (attachmentId: string) => string {
  return (id) => {
    const bucket = Math.floor(Date.now() / ARTIFACT_CAP_TTL_MS) + 2;
    return mintArtifactCapability(key, attachmentSubject(id), bucket * ARTIFACT_CAP_TTL_MS);
  };
}

/**
 * Resolve a stored absolute path, honoured only if it lands inside `root` and is a
 * regular file. Lexical containment first, then `realpathSync` on both sides, so a
 * symlink under the root cannot point outside it — the two guards
 * {@link resolveConfinedArtifact} makes, over one root and an always-absolute ref.
 */
function confinedTo(root: string, path: string): string | null {
  const target = resolve(path);
  const rootAbs = resolve(root);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;
  try {
    const real = realpathSync(target);
    const realRoot = realpathSync(rootAbs);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null; // missing path, broken symlink, permission error — treat as not found
  }
}

/**
 * Mint a capability into every artifact URL the state snapshot ships. Built here
 * rather than in `buildApp` so the ttl, the minting and the verifying are one
 * module — the route above is the only reader of what this signs.
 */
export function artifactSignerFor(key: Buffer): (flagId: string) => string {
  return (flagId) => mintArtifactCapability(key, flagId, Date.now() + ARTIFACT_CAP_TTL_MS);
}

/**
 * Resolve a flagged artifact `ref` to an absolute path within one of the allowed
 * roots — the agent's worktree `cwd` plus any operator-configured `trustedRoots`
 * (the absolute `docsFolderPrefix` entries) — or null if it doesn't exist, isn't a
 * regular file, or escapes every root (via `..` or a symlink). A relative ref is
 * resolved against `cwd`; an absolute ref is honoured only if it lands inside a
 * trusted root. Two guards: a *lexical* containment check against some root runs
 * before any filesystem access, then `realpathSync` on both sides defeats symlink
 * traversal.
 */
function resolveConfinedArtifact(cwd: string, ref: string, trustedRoots: string[]): string | null {
  // A relative ref is worktree-relative; an absolute ref must land inside one of
  // the operator-configured absolute prefixes (its own trusted root). The
  // worktree cwd is always a trusted root. Serving re-validates containment here
  // independently of the flag, so an odd stored ref can't read outside a root.
  const target = isAbsolute(ref) ? resolve(ref) : resolve(cwd, ref);
  const roots = [cwd, ...trustedRoots];
  // Lexical containment against *some* root, before touching the filesystem.
  if (!roots.some((root) => target === root || target.startsWith(root + sep))) return null;
  try {
    const real = realpathSync(target);
    // Real-path containment: a symlink inside a root can't point outside it.
    const contained = roots.some((root) => {
      const realRoot = realpathSync(root);
      return real === realRoot || real.startsWith(realRoot + sep);
    });
    if (!contained) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null; // missing path, broken symlink, permission error — treat as not found
  }
}

/** The absolute entries of `docsFolderPrefix` — the extra trusted roots the artifact route may serve from. */
export function absolutePrefixes(docsFolderPrefix?: string | string[]): string[] {
  if (docsFolderPrefix === undefined) return [];
  const list = Array.isArray(docsFolderPrefix) ? docsFolderPrefix : [docsFolderPrefix];
  return list.filter((p) => isAbsolute(p)).map((p) => resolve(p));
}

/**
 * How long an artifact capability lives. Short, because a capability travels in a
 * URL (the one place a navigation can carry it) and a URL is the leakiest transport
 * we have. Long enough to comfortably outlast the gap between a state poll minting
 * the URL and the operator clicking it: the snapshot re-mints on every poll, so a
 * click is almost always against a capability seconds old, and even a backgrounded
 * tab's stale chip stays clickable for a few minutes.
 */
const ARTIFACT_CAP_TTL_MS = 5 * 60_000;

const ARTIFACT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

/** Content type for a served artifact, by extension; opaque octet-stream otherwise. */
function artifactMime(file: string): string {
  return ARTIFACT_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
