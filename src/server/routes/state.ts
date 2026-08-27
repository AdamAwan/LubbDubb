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

/**
 * What the cockpit reads about the harness rather than about the work: the state
 * snapshot it polls, and the three constants it fetches once.
 */
export function register(app: FastifyInstance, { system, artifactSigner, attachmentSigner, hub }: RouteContext): void {
  const { config, errors, liveConfig, store, updates, agents, runtimeControl } = system;
  const filePath = system.configFile;
  const projectPath = system.projectConfigFile;

  /**
   * What the targeted project's shared config is contributing, right now.
   *
   * Read per request rather than captured at boot because it is a file in a
   * repository the operator pulls: a teammate's change lands while the harness is
   * up, and the watcher applies it — a snapshot here would leave the settings page
   * attributing values to a version of the file nobody is running.
   *
   * A broken file is recorded and read as empty rather than thrown: this is the
   * page an operator opens *because* something looks wrong, and a 500 over a
   * half-typed team config would take away the one surface that could tell them.
   */
  function projectLayer(): Partial<Config> {
    try {
      return projectConfigLayer(projectPath);
    } catch (err) {
      errors.record({ source: 'server', message: `Failed to read ${projectPath}: ${(err as Error).message}` });
      return {};
    }
  }

  /**
   * The cockpit snapshot, whole or in named parts.
   *
   * `?sections=fleet,activity` builds and answers only those (plus `refUrls`,
   * which every response carries); a bare call answers the lot, which is what the
   * first load asks for. An unknown name is **refused rather than ignored**: a
   * typo silently answering less is a cockpit that quietly stops updating a
   * surface, which is the failure this route exists to make impossible.
   *
   * The point is not payload — it is the rebuild. A `dirty` rides every file an
   * agent writes, every usage report and every progress note, none of which can
   * change a goal's pickup verdict; the goal enrichment was ~75 ms of a ~125 ms
   * build, paid per signal per open cockpit. The socket names what a signal
   * touched and the browser asks for that.
   * → `docs/spec/16-http-api.md#sections`
   */
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
        ? buildStateSnapshot(system, { artifactSigner, attachmentSigner })
        : buildStateSections(system, query.sections, { artifactSigner, attachmentSigner }),
    ),
  );

  // The prompt book the rule dispatcher renders from — what the harness says to
  // its agents, and which of those wordings the operator has replaced.
  //
  // Its own route, fetched on open rather than shipped on `/api/state`, for the
  // work graph's reason inverted: the graph is too big to poll, this is too
  // *static* to. `loadPromptTemplates` reads the override directory once at boot,
  // so the book cannot change while the process is up and re-sending it every
  // couple of seconds would be paying for a constant.
  //
  // Read-only on purpose. Editing stays a file drop into `promptTemplatesDir`:
  // a write route would have to answer "when does this take effect", and the
  // honest answer — at the next restart — is worse than not offering it. `dir`
  // is what makes the panel actionable without one.
  app.get(
    '/api/prompts',
    async () =>
      ({
        dir: config.promptTemplatesDir ?? null,
        templates: system.prompts.describe(),
      }) satisfies PromptsPayload,
  );

  // The configuration this process is actually running on, for the cockpit's
  // settings modal. Fetched on open rather than polled, for the prompt book's
  // reason exactly: `loadConfig` runs once at boot and the result cannot change
  // while the harness is up, so shipping it on every `/api/state` poll would be
  // paying for a constant.
  //
  // Writable since #401, which is a narrower change than it reads as: what a
  // save can promise is decided per field, not for the surface. A key with an arm
  // in `configApply.ts` takes effect on save; every other key lands in the file
  // and is reported as pending until a restart, rather than the route pretending
  // either that it applied or that nothing can.
  //
  // `revision` and `pending` ride along because a form needs both to be honest:
  // the first is what makes a stale save refusable, the second is what the
  // cockpit says instead of implying a restart-only change is in force.
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
        // Whether this process has anywhere to hand off to. `main.ts` wires the
        // handoff only when the supervisor launched it, so a deployment started by
        // hand answers false — and the cockpit says so instead of offering a
        // restart that would only stop the harness.
        canRestart: updates.onHandoff !== null,
      }) satisfies RunningConfigPayload,
  );

  // How the operator points their **own** Claude Code at this harness, for the
  // config page's MCP tab. Fetched on open for the prompt book's reason: the
  // bridge path, the two file paths and the tool descriptions are all fixed for
  // the life of the process.
  //
  // The registration is asked of the channel rather than composed here. It is one
  // command an operator pastes exactly once, and the only thing worse than not
  // offering it is offering a path that was right in development — the bridge is
  // resolved from the server module's own URL, so it is correct in a checkout and
  // in a `dist` install without either of them being a case anyone has to think
  // about.
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

  /**
   * Everything a write has to get past, in the order a reader would blame it —
   * and the reason all three write routes share one function rather than three
   * copies of a ladder that must not differ: a preview that refused less than the
   * save it previews is worse than no preview.
   *
   * Answers the candidate file text and the config it would produce, or the
   * refusal with the status to send it under.
   */
  type Prepared = { ok: true; text: string; next: Config } | { ok: false; status: number; error: string };

  function prepare(
    current: string,
    baseline: string,
    edits: { set?: Record<string, unknown>; clear?: readonly string[]; text?: string },
  ): Prepared {
    // A form built against a file that has moved would clobber whatever moved it
    // — an editor, or Claude, both of which are supported ways to configure this
    // harness. Refused with what to do about it.
    if (configRevision(current) !== baseline) {
      return {
        ok: false,
        status: 409,
        error: `${filePath} changed since this was loaded — reload before saving.`,
      };
    }

    let candidate: string;
    if (edits.text !== undefined) {
      // The raw arm hands over the whole file, so there is no per-field ladder to
      // walk: what a hand-written file may say is the loader's question, below,
      // exactly as it is at boot.
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

  /** Write the prepared text and apply it. Shared by the field save and the raw one. */
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

  // Saving is: refuse what must not be written, build the file the edits would
  // produce, build the *config* that file would produce, and only then write.
  //
  // The order is the whole of it. Validating by loading means the loader's own
  // refusal is the message the operator reads — including the reachable-host with
  // auth-off refusal, an unknown CI routing and a model profile naming a rule that
  // does not exist — so the form cannot save a config the next boot would reject.
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

  // The same ladder, stopping short of the write: what the file *would* say, and
  // what applying it would do. The review step draws the diff from this, which is
  // the whole reason it can promise anything about the bytes — it is shown the
  // ones that would be written, not a browser's guess at them.
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

  // The whole file, written by hand in the cockpit.
  //
  // Deliberately the same ladder and the same apply as the field save: the raw
  // arm skips only the per-field checks, which have nothing to check when the
  // operator has handed over every byte. What it does not skip is the loader —
  // so a removed key is refused by name here exactly as it would be at boot,
  // which is what makes this an editor rather than a way to brick a deployment.
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

  // Applying a restart-only change: pause dispatch and hand this process off to
  // the supervisor, which relaunches it on the config the file now holds.
  //
  // Two refusals, both 409s with the desk's wording rather than 400s, because the
  // request is well-formed and the operator is not wrong — the world is simply not
  // ready. Agents running is the first; the honest degradation is the second,
  // since a deployment the supervisor did not start has nothing to come back from
  // an exit, and offering a restart that only stops the harness would be worse
  // than offering none.
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
      const live = store.countLiveAgents();
      if (live > 0 && !body.interrupt) {
        return reply.code(409).send({
          error: `${live} agent(s) are still running — wait for the fleet to drain, or restart with interrupt to stop them now (they come back on the next boot).`,
        });
      }
      // Nothing new is dispatched into a process that is going down. The interrupt
      // leaves every live agent resumable, which is what the boot after offers.
      runtimeControl.apply({ paused: true });
      if (live > 0) agents.interruptAll();
      hub.broadcast({ type: 'dirty' });
      handoff();
      return { ok: true };
    }),
  );

  // What `config.ci.checks` *means*, for the settings modal's CI tab. Its own
  // route rather than another group on `/api/config` because it is a derivation
  // and not a reading: the raw array is already on that payload, and what the
  // operator cannot get from it is the part `classifyCiFailures` supplies — the
  // `ignore` a rule inherits by omitting `onFailure`, the `dispatch` an unmatched
  // check gets, and which branch-policy kinds become checks at all.
  //
  // Fetched on open and read-only, for the two routes above's reasons exactly.
  app.get('/api/ci-policy', async () => ({ policy: describeCiPolicy(config) }) satisfies CiPolicyPayload);

  app.get('/api/health', async () => ({ ok: true }));
}
