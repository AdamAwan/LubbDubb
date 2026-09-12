import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StateSection } from '../../wire.js';
import type {
  CiPolicyPayload,
  ConfigPreviewPayload,
  ConfigSavePayload,
  McpChannelPayload,
  PromptsPayload,
  RunningConfigPayload,
} from '../../wire.js';
import { describeCiPolicy } from '../../ci/describeCiPolicy.js';
import { loadConfigFromText, projectConfigLayer, type Config } from '../../config.js';
import { diffConfig } from '../../configApply.js';
import { configField, envOverride, fieldValueRefusal } from '../../configFields.js';
import { configRevision, editConfigText, readConfigText, writeConfigText } from '../../configFile.js';
import { MCP_SERVER_ID } from '../../mcp/names.js';
import { describeRunningConfig } from '../runningConfig.js';
import { buildStateSections, buildStateSnapshot, STATE_SECTIONS } from '../stateSnapshot.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(
  app: FastifyInstance,
  { system, artifactSigner, attachmentSigner, localValidationFileSigner, validationCaptureSigner, hub }: RouteContext,
): void {
  const { config, errors, liveConfig, store, updates, agents, runtimeControl } = system;
  const filePath = system.configFile;
  const projectPath = system.projectConfigFile;

  function projectLayer(): Partial<Config> {
    try {
      return projectConfigLayer(projectPath);
    } catch (err) {
      errors.record({ source: 'server', message: `Failed to read ${projectPath}: ${(err as Error).message}` });
      return {};
    }
  }

  const StateQuery = z.object({
    sections: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined) return undefined;
        const named = raw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '');
        const unknown = named.filter((part) => !(STATE_SECTIONS as readonly string[]).includes(part));
        if (unknown.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown state section(s): ${unknown.join(', ')} — known: ${STATE_SECTIONS.join(', ')}`,
          });
          return z.NEVER;
        }
        return new Set(named as StateSection[]);
      }),
  });
  app.get(
    '/api/state',
    checked({ query: StateQuery }, async ({ query }) =>
      query.sections === undefined
        ? buildStateSnapshot(system, {
            artifactSigner,
            attachmentSigner,
            localValidationFileSigner,
            validationCaptureSigner,
          })
        : buildStateSections(system, query.sections, {
            artifactSigner,
            attachmentSigner,
            localValidationFileSigner,
            validationCaptureSigner,
          }),
    ),
  );

  app.get(
    '/api/prompts',
    async () =>
      ({
        dir: config.promptTemplatesDir ?? null,
        templates: system.prompts.describe(),
      }) satisfies PromptsPayload,
  );

  app.get(
    '/api/config',
    async () =>
      ({
        groups: describeRunningConfig(config, projectLayer()),
        file: filePath,
        projectFile: existsSync(projectPath) ? projectPath : null,
        text: readConfigText(filePath),
        revision: configRevision(readConfigText(filePath)),
        pending: liveConfig.pending(),
        canRestart: updates.onHandoff !== null,
      }) satisfies RunningConfigPayload,
  );

  app.get(
    '/api/mcp',
    async () =>
      ({
        running: system.desktop.running(),
        serverId: MCP_SERVER_ID,
        registration: system.desktop.registration(),
        credentialPath: system.desktop.credentialPath(),
        skillPath: config.validation.desktopSkillPath,
        tools: system.desktop.advertised(),
      }) satisfies McpChannelPayload,
  );

  type Prepared = { ok: true; text: string; next: Config } | { ok: false; status: number; error: string };

  function prepare(
    current: string,
    baseline: string,
    edits: { set?: Record<string, unknown>; clear?: readonly string[]; text?: string },
  ): Prepared {
    if (configRevision(current) !== baseline) {
      return {
        ok: false,
        status: 409,
        error: `${filePath} changed since this was loaded — reload before saving.`,
      };
    }

    let candidate: string;
    if (edits.text !== undefined) {
      candidate = edits.text;
    } else {
      const set = edits.set ?? {};
      for (const path of [...Object.keys(set), ...(edits.clear ?? [])]) {
        const field = configField(path);
        if (!field) return { ok: false, status: 400, error: `${path} is not a configurable field` };
        if (field.access === 'fileOnly') {
          return { ok: false, status: 400, error: `${path} is edited in the file, not here` };
        }
        const env = envOverride(field);
        if (env) {
          return {
            ok: false,
            status: 400,
            error: `${path} is set by ${env} in this harness's environment, which beats the file`,
          };
        }
        const refusal = Object.hasOwn(set, path) ? fieldValueRefusal(field, set[path]) : null;
        if (refusal) return { ok: false, status: 400, error: refusal };
      }
      try {
        candidate = editConfigText(current, { set, clear: edits.clear ?? [] });
      } catch (err) {
        return { ok: false, status: 400, error: `${filePath} could not be edited: ${(err as Error).message}` };
      }
    }

    try {
      return { ok: true, text: candidate, next: loadConfigFromText(candidate, filePath) };
    } catch (err) {
      return { ok: false, status: 400, error: (err as Error).message };
    }
  }

  function commit(text: string, next: Config): ConfigSavePayload | { failed: string } {
    try {
      writeConfigText(filePath, text);
    } catch (err) {
      errors.record({ source: 'server', message: `Failed to write ${filePath}: ${(err as Error).message}` });
      return { failed: `${filePath} could not be written: ${(err as Error).message}` };
    }
    const changes = liveConfig.apply(next);
    hub.broadcast({ type: 'config:changed' });
    return { ok: true, revision: configRevision(text), changes, pending: liveConfig.pending() };
  }

  const ConfigSaveBody = z.object({
    set: z.record(z.unknown(), { invalid_type_error: 'set must be an object of path → value' }).optional(),
    clear: z.array(z.string(), { invalid_type_error: 'clear must be a list of paths' }).optional(),
    baseline: z.string({ required_error: 'baseline is required', invalid_type_error: 'baseline must be a string' }),
  });
  app.post(
    '/api/config',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    checked({ body: ConfigSaveBody }, async ({ body, reply }) => {
      if (Object.keys(body.set ?? {}).length === 0 && (body.clear ?? []).length === 0) {
        return reply.code(400).send({ error: 'nothing to save: neither set nor clear named a field' });
      }
      const prepared = prepare(readConfigText(filePath), body.baseline, { set: body.set, clear: body.clear });
      if (!prepared.ok) return reply.code(prepared.status).send({ error: prepared.error });

      const result = commit(prepared.text, prepared.next);
      if ('failed' in result) return reply.code(500).send({ error: result.failed });
      return result;
    }),
  );

  const ConfigPreviewBody = z.object({
    set: z.record(z.unknown(), { invalid_type_error: 'set must be an object of path → value' }).optional(),
    clear: z.array(z.string(), { invalid_type_error: 'clear must be a list of paths' }).optional(),
    text: z.string({ invalid_type_error: 'text must be a string' }).optional(),
    baseline: z.string({ required_error: 'baseline is required', invalid_type_error: 'baseline must be a string' }),
  });
  app.post(
    '/api/config/preview',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    checked({ body: ConfigPreviewBody }, async ({ body, reply }) => {
      const prepared = prepare(readConfigText(filePath), body.baseline, {
        set: body.set,
        clear: body.clear,
        ...(body.text !== undefined ? { text: body.text } : {}),
      });
      if (!prepared.ok) return reply.code(prepared.status).send({ error: prepared.error });
      return {
        ok: true,
        text: prepared.text,
        changes: diffConfig(config, prepared.next),
      } satisfies ConfigPreviewPayload;
    }),
  );

  const ConfigRawBody = z.object({
    text: z.string({ required_error: 'text is required', invalid_type_error: 'text must be a string' }),
    baseline: z.string({ required_error: 'baseline is required', invalid_type_error: 'baseline must be a string' }),
  });
  app.post(
    '/api/config/raw',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    checked({ body: ConfigRawBody }, async ({ body, reply }) => {
      const prepared = prepare(readConfigText(filePath), body.baseline, { text: body.text });
      if (!prepared.ok) return reply.code(prepared.status).send({ error: prepared.error });

      const result = commit(prepared.text, prepared.next);
      if ('failed' in result) return reply.code(500).send({ error: result.failed });
      return result;
    }),
  );

  const RestartBody = z.object({
    interrupt: z.boolean({ invalid_type_error: 'interrupt must be a boolean' }).optional(),
  });
  app.post(
    '/api/config/restart',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    checked({ body: RestartBody }, async ({ body, reply }) => {
      const handoff = updates.onHandoff;
      if (!handoff) {
        return reply.code(409).send({
          error:
            'This harness was not started by the supervisor, so nothing here can restart it. ' +
            'Restart it the way you started it — the pending changes are what it will come back on.',
        });
      }
      const live = store.agents.countLiveAgents();
      if (live > 0 && !body.interrupt) {
        return reply.code(409).send({
          error: `${live} agent(s) are still running — wait for the fleet to drain, or restart with interrupt to stop them now (they come back on the next boot).`,
        });
      }
      runtimeControl.apply({ paused: true });
      if (live > 0) agents.interruptAll();
      hub.broadcast({ type: 'dirty' });
      handoff();
      return { ok: true };
    }),
  );

  app.get('/api/ci-policy', async () => ({ policy: describeCiPolicy(config) }) satisfies CiPolicyPayload);

  app.get('/api/health', async () => ({ ok: true }));
}
