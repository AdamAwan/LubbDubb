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

  /**
   * Calling it off.
   *
   * **The stack model is not consulted to find the intent, and must not be.**
   * `landingScope` resolves a ref through `buildStacks`, and a chain of one is not
   * a stack — so the moment a two-rung chain's bottom rung merges, every ref the
   * operator could send 404s while the intent goes on authorizing the surviving
   * rung's merge. That is the orphaning `StackLanding` is keyed on rungs to avoid,
   * arriving one step later: at the last rung instead of the first. The 404 read
   * "no open stack stack:1", which an operator reasonably parses as "there is
   * nothing standing to stop" — the opposite of the truth.
   *
   * So the ref is read for the rung it names (`stack:<bottom PR>`) and the intent
   * is found by what it covers, exactly as `revoke` is written to be. `POST` keeps
   * going through `landingScope`, because the scope of an authorization is the
   * server's own reading of the chain; `DELETE` authorizes nothing, so the model
   * may widen its search but may never gate it.
   */
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

      // Only to widen: a ref whose own rung is not in any standing intent may
      // still name a chain one of whose other rungs is. A ref that resolves to no
      // stack is not an error here — there may be nothing standing, which is what
      // the 404 below says.
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

/**
 * The PR number a stack ref names — `stack:124` → `124`, and null for anything
 * else. The bottom rung at the time the ref was minted, which is all `revoke`
 * needs: it is keyed on a rung, and one PR belongs to one chain.
 *
 * A fork's paths share a bottom and so spell their refs `stack:<bottom>:<leaf>`;
 * the trailing segment is ignored here, because either rung finds the same
 * standing intent.
 */
function rungOf(ref: string): number | null {
  const match = /^stack:(\d+)(?::\d+)?$/.exec(ref);
  return match ? Number(match[1]) : null;
}
