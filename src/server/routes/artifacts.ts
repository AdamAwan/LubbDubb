import type { FastifyInstance } from 'fastify';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { mintArtifactCapability, verifyArtifactCapability } from '../artifactCapability.js';
import { z } from 'zod';
import { checked, IdParams } from '../validation.js';
import { localValidationOutputDir } from '../../localValidation/origin.js';
import type { RouteContext } from './context.js';

/**
 * Serving a local file the cockpit may look at — one an agent flagged, one an operator
 * attached to a brief, or a validation screenshot — and the capability that authorizes it.
 * All are reached by the browser *without* the cockpit's bearer token (a navigation or an
 * `<img>` load), so all sit outside the `/api` prefix guard and carry a short-lived,
 * per-subject capability instead.
 */
export function register(app: FastifyInstance, { system, artifactKey }: RouteContext): void {
  const { store, config } = system;

  // Operator-configured absolute docsFolderPrefix entries are trusted roots this
  // route may serve from, on top of each agent's worktree.
  const artifactRoots = absolutePrefixes(config.docsFolderPrefix);

  // Serve a local artifact an agent flagged, addressed by its flag id. The path comes
  // from the stored flag row, never the request, and is confined to that agent's
  // worktree or an absolute `docsFolderPrefix` root. Sandboxed CSP so agent-authored
  // HTML can't script the cockpit's origin.
  //
  // Outside the `/api` prefix on purpose: a top-level navigation cannot set an
  // `Authorization` header, so it authorizes itself with a per-flag capability in
  // the query string instead.
  app.get(
    '/artifacts/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    checked({ params: IdParams }, async ({ params, req, reply }) => {
      const { id } = params;
      // Capability first, before the flag is looked up, so the route does not confirm
      // which flag ids exist to a caller holding none. Skipped only when auth is off.
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

  // Serve an image the operator attached to a brief, addressed by its attachment id.
  // Outside `/api` because an `<img src>` subresource fetch carries no `Authorization`
  // header. The path comes from the stored row and is re-confined to `attachmentRoot`.
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
        // The stored mime, sniffed from the bytes rather than declared by the uploader,
        // with `nosniff`. `sandbox`: outside bytes rendered on the harness's own origin.
        .header('content-type', attachment.mime)
        .header('content-security-policy', 'sandbox')
        .header('x-content-type-options', 'nosniff')
        // Immutable: an attachment's bytes never change, and the URL is stable across
        // polls. `private`, because a capability URL must never sit in a shared cache.
        .header('cache-control', 'private, max-age=300, immutable');
      return reply.send(readFileSync(file));
    }),
  );

  // Serve a screenshot a validating agent saved, outside `/api` for the attachment
  // route's reason. Unlike the routes above the name comes from the request, so it
  // is checked for a separator before joining and re-confined to the row's own directory.
  app.get(
    '/local-validations/:id/files/:name',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    checked({ params: LocalValidationFileParams }, async ({ params, req, reply }) => {
      const { id, name } = params;
      if (artifactKey) {
        const tk = (req.query as { tk?: unknown })?.tk;
        if (
          typeof tk !== 'string' ||
          !verifyArtifactCapability(artifactKey, tk, localValidationFileSubject(id, name), Date.now())
        )
          return reply.code(401).send({ error: 'missing or invalid screenshot capability' });
      }
      const row = store.getLocalValidation(id);
      if (!row) return reply.code(404).send({ error: 'validation not found' });
      const dir = localValidationOutputDir(config.validationRoot, row.originRef, row.id);
      const file = confinedTo(dir, resolve(dir, name));
      if (!file) return reply.code(404).send({ error: 'screenshot not found' });
      reply
        // Sniffed from the extension; `sandbox` and `nosniff` for the attachment
        // route's reasons — still outside bytes on the harness's own origin.
        .header('content-type', artifactMime(file))
        .header('content-security-policy', 'sandbox')
        .header('x-content-type-options', 'nosniff')
        // Immutable: written once by an agent that has since finished, URL stable across
        // polls. `private`, because a capability URL must never sit in a shared cache.
        .header('cache-control', 'private, max-age=300, immutable');
      return reply.send(readFileSync(file));
    }),
  );
}

/**
 * What an attachment capability is signed over. Namespaced so a capability minted for a
 * flag cannot open an attachment, or the reverse, even if the id spaces ever collided.
 */
function attachmentSubject(id: string): string {
  return `attachment:${id}`;
}

/**
 * A screenshot's path parameters. The name is a file name, restated here because this
 * is the layer where the string becomes a filesystem read.
 */
const LocalValidationFileParams = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !/[\\/]/.test(n) && n !== '.' && n !== '..', 'not a file name'),
});

/**
 * What a screenshot capability is signed over — namespaced, and over the **pair**: a
 * capability minted for one file of a validation must not open another.
 */
function localValidationFileSubject(id: string, name: string): string {
  return `local-validation:${id}:${name}`;
}

/**
 * Mint a capability into every screenshot URL the snapshot ships, on
 * {@link attachmentSignerFor}'s bucketed clock: the URL must be stable across polls.
 */
export function localValidationFileSignerFor(key: Buffer): (id: string, name: string) => string {
  return (id, name) => {
    const bucket = Math.floor(Date.now() / ARTIFACT_CAP_TTL_MS) + 2;
    return mintArtifactCapability(key, localValidationFileSubject(id, name), bucket * ARTIFACT_CAP_TTL_MS);
  };
}

/** Mint a capability into every attachment URL the snapshot ships. The expiry is bucketed, unlike an artifact's: a thumbnail is an `<img src>` load, so a URL changing every poll could never hit the cache — it lives between one and two buckets rather than exactly one TTL. */
export function attachmentSignerFor(key: Buffer): (attachmentId: string) => string {
  return (id) => {
    const bucket = Math.floor(Date.now() / ARTIFACT_CAP_TTL_MS) + 2;
    return mintArtifactCapability(key, attachmentSubject(id), bucket * ARTIFACT_CAP_TTL_MS);
  };
}

/**
 * Resolve a stored absolute path, honoured only if it lands inside `root` and is a regular
 * file. Lexical containment first, then `realpathSync` on both sides, so a symlink under
 * the root cannot point outside it.
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
 * Mint a capability into every artifact URL the state snapshot ships. Built here so the
 * ttl, the minting and the verifying stay one module.
 */
export function artifactSignerFor(key: Buffer): (flagId: string) => string {
  return (flagId) => mintArtifactCapability(key, flagId, Date.now() + ARTIFACT_CAP_TTL_MS);
}

/**
 * Resolve a flagged artifact `ref` to an absolute path within one of the allowed roots —
 * the agent's worktree `cwd` plus the absolute `docsFolderPrefix` entries — or null if it
 * doesn't exist, isn't a regular file, or escapes every root via `..` or a symlink. Two
 * guards: lexical containment before any filesystem access, then `realpathSync` on both
 * sides against symlink traversal.
 */
function resolveConfinedArtifact(cwd: string, ref: string, trustedRoots: string[]): string | null {
  // A relative ref is worktree-relative; an absolute one must land inside a configured
  // prefix. Containment is re-validated here independently of the flag.
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
 * How long an artifact capability lives. Short, because it travels in a URL; long enough
 * to outlast the gap between a state poll minting it and the operator clicking.
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
