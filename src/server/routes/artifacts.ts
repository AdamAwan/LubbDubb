import type { FastifyInstance } from 'fastify';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { mintArtifactCapability, verifyArtifactCapability } from '../artifactCapability.js';
import { z } from 'zod';
import { checked, IdParams } from '../validation.js';
import { localValidationOutputDir } from '../../localValidation/origin.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, artifactKey }: RouteContext): void {
  const { store, config } = system;

  const artifactRoots = absolutePrefixes(config.docsFolderPrefix);

  app.get(
    '/artifacts/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    checked({ params: IdParams }, async ({ params, req, reply }) => {
      const { id } = params;
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
        .header('content-type', attachment.mime)
        .header('content-security-policy', 'sandbox')
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=300, immutable');
      return reply.send(readFileSync(file));
    }),
  );

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
        .header('content-type', artifactMime(file))
        .header('content-security-policy', 'sandbox')
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=300, immutable');
      return reply.send(readFileSync(file));
    }),
  );
}

function attachmentSubject(id: string): string {
  return `attachment:${id}`;
}

const LocalValidationFileParams = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !/[\\/]/.test(n) && n !== '.' && n !== '..', 'not a file name'),
});

function localValidationFileSubject(id: string, name: string): string {
  return `local-validation:${id}:${name}`;
}

export function localValidationFileSignerFor(key: Buffer): (id: string, name: string) => string {
  return (id, name) => {
    const bucket = Math.floor(Date.now() / ARTIFACT_CAP_TTL_MS) + 2;
    return mintArtifactCapability(key, localValidationFileSubject(id, name), bucket * ARTIFACT_CAP_TTL_MS);
  };
}

export function attachmentSignerFor(key: Buffer): (attachmentId: string) => string {
  return (id) => {
    const bucket = Math.floor(Date.now() / ARTIFACT_CAP_TTL_MS) + 2;
    return mintArtifactCapability(key, attachmentSubject(id), bucket * ARTIFACT_CAP_TTL_MS);
  };
}

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
    return null;
  }
}

export function artifactSignerFor(key: Buffer): (flagId: string) => string {
  return (flagId) => mintArtifactCapability(key, flagId, Date.now() + ARTIFACT_CAP_TTL_MS);
}

function resolveConfinedArtifact(cwd: string, ref: string, trustedRoots: string[]): string | null {
  const target = isAbsolute(ref) ? resolve(ref) : resolve(cwd, ref);
  const roots = [cwd, ...trustedRoots];
  if (!roots.some((root) => target === root || target.startsWith(root + sep))) return null;
  try {
    const real = realpathSync(target);
    const contained = roots.some((root) => {
      const realRoot = realpathSync(root);
      return real === realRoot || real.startsWith(realRoot + sep);
    });
    if (!contained) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

export function absolutePrefixes(docsFolderPrefix?: string | string[]): string[] {
  if (docsFolderPrefix === undefined) return [];
  const list = Array.isArray(docsFolderPrefix) ? docsFolderPrefix : [docsFolderPrefix];
  return list.filter((p) => isAbsolute(p)).map((p) => resolve(p));
}

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

function artifactMime(file: string): string {
  return ARTIFACT_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
