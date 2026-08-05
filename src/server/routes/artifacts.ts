import type { FastifyInstance } from 'fastify';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { mintArtifactCapability, verifyArtifactCapability } from '../artifactCapability.js';
import { checked, IdParams } from '../validation.js';
import type { RouteContext } from './context.js';

/** Serving a local file an agent flagged, and the capability that authorizes the navigation. */
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
