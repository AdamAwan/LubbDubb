import type { FastifyInstance } from 'fastify';
import type { CiPolicyPayload, PromptsPayload, RunningConfigPayload } from '../../wire.js';
import { describeCiPolicy } from '../../ci/describeCiPolicy.js';
import { describeRunningConfig } from '../runningConfig.js';
import { buildStateSnapshot } from '../stateSnapshot.js';
import type { RouteContext } from './context.js';

/**
 * What the cockpit reads about the harness rather than about the work: the state
 * snapshot it polls, and the three constants it fetches once.
 */
export function register(app: FastifyInstance, { system, artifactSigner, attachmentSigner }: RouteContext): void {
  const { config } = system;

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
  // Read-only, and for the prompt book's reason again: a write route's honest
  // answer to "when does this take effect" is "at the next restart". The two
  // values that *are* live — the agent cap and the pause flag — are already on
  // the snapshot as `control`, and the modal draws them beside their configured
  // counterparts rather than letting this block claim a cap that is not in force.
  app.get('/api/config', async () => ({ groups: describeRunningConfig(config) }) satisfies RunningConfigPayload);

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
