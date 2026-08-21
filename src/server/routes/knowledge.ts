import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { distinctCorroborators } from '../../knowledge/knowledge.js';
import type { FactRuling, KnowledgeFactPayload } from '../../wire.js';
import { checked, IdParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * What the fleet knows about working this repository, as an operator reaches it
 * (issue #27 phase 2): the observations behind one claim, and the reach
 * transitions that are the whole of the governance.
 *
 * **The transitions are the whole write surface here.** Nothing on this page
 * files a fact — agents do that through `knowledge_propose`, on a scoped MCP
 * credential rather than the cockpit's bearer token, which is the same split
 * `lessons.ts` describes between its own two writers. And nothing here promotes
 * on anybody's behalf: the store carries a claim to `lookup` on two independent
 * corroborations and no further, so `injected` is an operator's and only an
 * operator's, and a route that reached past `setFactReach` would be doing what
 * the store refuses to.
 *
 * **A rejection is terminal, so there is no un-reject route.** The bar is what
 * stops two agents re-proposing next week what an operator killed today; an
 * un-reject would be a way to lift it without reading the amendment that should
 * have lifted it. What comes back is an amendment naming the barred claim, filed
 * by the agent that found the sharper version — which is a tool call, not a click.
 *
 * There is no list route: the facts ride on `/api/state` with everything else the
 * cockpit polls, exactly as findings and lessons do, so the page draws them beside
 * refs the snapshot's own link map resolves. What does *not* ride there is the
 * evidence — thousands of characters per observation, on a polled snapshot — so
 * the provenance a reader opens a row for is fetched per fact below.
 *
 * → `docs/spec/27-knowledge.md`, `docs/spec/16-http-api.md`
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  // One claim with the observations behind it, in the observers' own words. The
  // count is what promotes a fact; this is what an operator reads to decide
  // whether it should have, which is why the words are a row's own fetch rather
  // than a field nobody has opened yet paying for on every poll.
  app.get(
    '/api/knowledge/facts/:id',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const fact = store.getFact(params.id);
      if (!fact) return reply.code(404).send({ error: 'fact not found' });
      const corroborations = store.listCorroborations(fact.id);
      return {
        // Counted here through the same function the store promotes on, never as
        // `corroborations.length`: two observations are one corroborator if they
        // share a goal or a session, so the length is a different number that
        // looks like the same one.
        fact: { ...fact, corroborations: distinctCorroborators(corroborations) },
        corroborations,
      } satisfies KnowledgeFactPayload;
    }),
  );

  /**
   * The moves an operator has, as one route, because they are one act — *this is
   * how far the claim carries* — and the store writes them through one guarded
   * update.
   *
   * Promote, demote, reject and **keep**: naming the reach a claim already has is
   * a ruling rather than a no-op, and the only way an operator says "I have read
   * this corroborated claim and `lookup` is where it belongs". Without it the
   * page's Needs you section would ask again forever.
   *
   * `proposal` is absent from the body because nothing moves a claim back to
   * "nobody has agreed with this"; `committed` is absent because a fact leaves
   * for the repository through a documentation pull request that does not exist
   * yet (phase 6), and a route that set the reach without opening one would take
   * the claim out of every prompt while putting it nowhere.
   */
  // Typed as the wire's own narrowing of `FactReach`, so the three literals here
  // and the union the cockpit posts are one statement rather than two that agree
  // today.
  const RULINGS: [FactRuling, ...FactRuling[]] = ['lookup', 'injected', 'rejected'];
  const ReachBody = z.object({
    // One `errorMap` rather than the two stock messages, because a missing reach
    // and a reach nobody has heard of are the same mistake from the caller's side
    // — and zod's own enum wording names no field.
    reach: z.enum(RULINGS, {
      errorMap: () => ({
        message:
          'reach must be one of lookup (answered when an agent asks), injected (in front of every agent) ' +
          'or rejected (not true, and barred from coming back)',
      }),
    }),
  });
  app.post(
    '/api/knowledge/facts/:id/reach',
    checked({ params: IdParams, body: ReachBody }, async ({ params, body, reply }) => {
      // Read first so the two refusals are told apart, `lessons.ts`'s discipline:
      // an id that names nothing is a 404 whatever reach it was asked for, and a
      // claim the store will not move is a 409 that says why. The store's write is
      // guarded regardless, so the read is for the wording and never for the check.
      const existing = store.getFact(params.id);
      if (!existing) return reply.code(404).send({ error: 'fact not found' });
      const fact = store.setFactReach(params.id, body.reach);
      // The one refusal there is. Naming the reach a claim already has is *not*
      // one: an operator saying a corroborated claim belongs exactly where it is
      // is a ruling, and the page has no other way to record that it was made.
      if (!fact) {
        return reply.code(409).send({
          error: 'this claim was rejected, and a rejection is terminal — the way back is an amendment naming it',
        });
      }
      // `dirty` rather than `world:changed`: nothing in the world moved and no
      // cycle is run — the page simply has a row somewhere else. The reading
      // `dismissFinding` and `promoteLesson` both take.
      hub.broadcast({ type: 'dirty' });
      return { ok: true, fact };
    }),
  );
}
