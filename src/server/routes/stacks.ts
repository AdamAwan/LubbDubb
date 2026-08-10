import type { FastifyInstance } from 'fastify';
import type { StackLanding } from '../../types.js';
import { landingReadiness, landingScope } from '../../stacks/landing.js';
import { checked, RefParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The one verdict an operator casts on a whole chain of stacked pull requests:
 * land it, or call that off.
 *
 * A group of its own rather than a pair of routes bolted onto the PR endpoints,
 * because its subject is the chain and not any one pull request — and because the
 * thing it records is not a merge. Accepting a merge stays
 * `POST /api/proposals/:id/accept`; this records a standing intent that keeps
 * accepting them as rule `pr-merge-ready` proposes each rung, cycle after cycle.
 * See `src/stacks/landing.ts` for why that cannot be a loop.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, config, landings } = system;

  app.post(
    '/api/stacks/:ref/land',
    checked({ params: RefParams }, async ({ params, reply }) => {
      const { ref } = params;
      // The world the operator was looking at, read again here. The client sends
      // the ref alone and never the rungs: the scope of an authorization is the
      // server's own reading of the chain, so a caller cannot widen what it
      // covers by naming pull requests the stack does not contain.
      const world = await connector.getState();
      const scope = landingScope(
        ref,
        world.pullRequests,
        store.listPlans(),
        store.listAllPlanParts(),
        config.defaultBranch,
      );
      if (!scope.ok) return reply.code(404).send({ error: scope.error });

      // The button is disabled in the cockpit when a rung is not clear, and that
      // is a courtesy — this is the gate. Refused as a 409 rather than a 400: the
      // request is perfectly well-formed, and what is wrong is the state of the
      // world it asks about.
      const readiness = landingReadiness(scope.prs);
      if (!readiness.offer)
        return reply.code(409).send({ error: readiness.blockedBy ?? 'the stack is not ready to land' });

      const landing = landings.land(ref, scope.rungs);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, landing } satisfies { ok: true; landing: StackLanding };
    }),
  );

  // Calling it off. Keyed on the ref the cockpit is currently drawing, resolved to
  // a rung the same way the record was — the ref renames itself as rungs land, so
  // the intent is found by what it covers rather than by what it was called.
  app.delete(
    '/api/stacks/:ref/land',
    checked({ params: RefParams }, async ({ params, reply }) => {
      const { ref } = params;
      const world = await connector.getState();
      const scope = landingScope(
        ref,
        world.pullRequests,
        store.listPlans(),
        store.listAllPlanParts(),
        config.defaultBranch,
      );
      if (!scope.ok) return reply.code(404).send({ error: scope.error });
      const revoked = scope.rungs.map((n) => landings.revoke(n)).find((l) => l !== null);
      if (!revoked) return reply.code(404).send({ error: `nothing standing for ${ref}` });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, landing: revoked } satisfies { ok: true; landing: StackLanding };
    }),
  );
}
