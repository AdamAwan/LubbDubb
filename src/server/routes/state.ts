import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CiPolicyPayload, ConfigSavePayload, PromptsPayload, RunningConfigPayload } from '../../wire.js';
import { describeCiPolicy } from '../../ci/describeCiPolicy.js';
import { loadConfigFromText } from '../../config.js';
import { configField, envOverride, fieldValueRefusal } from '../../configFields.js';
import { configRevision, editConfigText, readConfigText, writeConfigText } from '../../configFile.js';
import { describeRunningConfig } from '../runningConfig.js';
import { buildStateSnapshot } from '../stateSnapshot.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * What the cockpit reads about the harness rather than about the work: the state
 * snapshot it polls, and the three constants it fetches once.
 */
export function register(app: FastifyInstance, { system, artifactSigner, attachmentSigner, hub }: RouteContext): void {
  const { config, errors, liveConfig, store, updates, agents, runtimeControl } = system;
  const filePath = system.configFile;

  app.get('/api/state', async () => buildStateSnapshot(system, { artifactSigner, attachmentSigner }));

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
        groups: describeRunningConfig(config),
        file: filePath,
        revision: configRevision(readConfigText(filePath)),
        pending: liveConfig.pending(),
        // Whether this process has anywhere to hand off to. `main.ts` wires the
        // handoff only when the supervisor launched it, so a deployment started by
        // hand answers false — and the cockpit says so instead of offering a
        // restart that would only stop the harness.
        canRestart: updates.onHandoff !== null,
      }) satisfies RunningConfigPayload,
  );

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
      const set = body.set ?? {};
      const clear = body.clear ?? [];
      if (Object.keys(set).length === 0 && clear.length === 0) {
        return reply.code(400).send({ error: 'nothing to save: neither set nor clear named a field' });
      }

      const current = readConfigText(filePath);
      // A form built against a file that has moved would clobber whatever moved
      // it — an editor, or Claude, both of which are supported ways to configure
      // this harness. Refused with what to do about it.
      if (configRevision(current) !== body.baseline) {
        return reply
          .code(409)
          .send({ error: `${filePath} changed since this form was loaded — reload before saving.` });
      }

      for (const path of [...Object.keys(set), ...clear]) {
        const field = configField(path);
        if (!field) return reply.code(400).send({ error: `${path} is not a configurable field` });
        if (field.access === 'fileOnly') {
          return reply.code(400).send({ error: `${path} is edited in the file, not here` });
        }
        const env = envOverride(field);
        if (env) {
          return reply
            .code(400)
            .send({ error: `${path} is set by ${env} in this harness's environment, which beats the file` });
        }
        const refusal = Object.hasOwn(set, path) ? fieldValueRefusal(field, set[path]) : null;
        if (refusal) return reply.code(400).send({ error: refusal });
      }

      let candidate: string;
      try {
        candidate = editConfigText(current, { set, clear });
      } catch (err) {
        return reply.code(400).send({ error: `${filePath} could not be edited: ${(err as Error).message}` });
      }

      let next;
      try {
        next = loadConfigFromText(candidate, filePath);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      try {
        writeConfigText(filePath, candidate);
      } catch (err) {
        errors.record({ source: 'server', message: `Failed to write ${filePath}: ${(err as Error).message}` });
        return reply.code(500).send({ error: `${filePath} could not be written: ${(err as Error).message}` });
      }

      const changes = liveConfig.apply(next);
      hub.broadcast({ type: 'config:changed' });
      return {
        ok: true,
        revision: configRevision(candidate),
        changes,
        pending: liveConfig.pending(),
      } satisfies ConfigSavePayload;
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
