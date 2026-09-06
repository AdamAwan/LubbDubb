import type { FastifyInstance } from 'fastify';
import type { StackLanding } from '../../types.js';
import { landingReadiness, landingScope } from '../../stacks/landing.js';
import { checked, RefParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, config, landings } = system;

  app.post(
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

      const readiness = landingReadiness(scope.prs);
      if (!readiness.offer)
        return reply.code(409).send({ error: readiness.blockedBy ?? 'the stack is not ready to land' });

      const landing = landings.land(ref, scope.rungs);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, landing } satisfies { ok: true; landing: StackLanding };
    }),
  );

  app.delete(
    '/api/stacks/:ref/land',
    checked({ params: RefParams }, async ({ params, reply }) => {
      const { ref } = params;
      const named = rungOf(ref);
      const direct = named === null ? null : landings.revoke(named);
      if (direct) {
        hub.broadcast({ type: 'dirty' });
        return { ok: true, landing: direct } satisfies { ok: true; landing: StackLanding };
      }

      const world = await connector.getState();
      const scope = landingScope(
        ref,
        world.pullRequests,
        store.listPlans(),
        store.listAllPlanParts(),
        config.defaultBranch,
      );
      const revoked = scope.ok ? scope.rungs.map((n) => landings.revoke(n)).find((l) => l !== null) : undefined;
      if (!revoked) return reply.code(404).send({ error: `nothing standing for ${ref}` });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, landing: revoked } satisfies { ok: true; landing: StackLanding };
    }),
  );
}

function rungOf(ref: string): number | null {
  const match = /^stack:(\d+)(?::\d+)?$/.exec(ref);
  return match ? Number(match[1]) : null;
}
