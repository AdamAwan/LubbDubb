import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkScopeDrift, checkSightings } from '../../knowledge/drift.js';
import { committableFact, factDocsFields, graduationNote } from '../../knowledge/graduation.js';
import { MAX_CLAIM_CHARS } from '../../knowledge/knowledge.js';
import type { FactRuling, KnowledgeContradictionView, KnowledgeFactPayload } from '../../wire.js';
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
  const { store, harness } = system;

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
      const contradictions = store.listContradictions(fact.id);
      // Every count on the row comes from `factCounts` — the same one read the
      // snapshot's rows are built from — rather than being re-derived here from the
      // lists fetched for their words. Two of them are counts of *voices* (an
      // agreement and a dispute are one voice if they share a goal or a session),
      // one is a division of the other two, and one is a count of asks in a third
      // table; a second implementation of any of them would be a number that looks
      // like the one beside it on the page an inch away and is free to disagree.
      const counts = store.factCounts().get(fact.id);
      // The `check:` staleness verdict, from the records that already hold the
      // evidence. Read here rather than shipped from the snapshot because the whole
      // row is: the payload is what a reader opens, and half of it coming from a
      // poll two seconds old is a row that disagrees with itself.
      const drift = checkScopeDrift(
        fact,
        checkSightings(store.listTasks(), store.getWorldBaseline()?.pullRequests ?? []),
        { now: Date.now(), staleDays: system.config.knowledgeScopeStaleDays },
      );
      return {
        fact: {
          ...fact,
          corroborations: 0,
          contradictions: 0,
          contradictionRatio: 0,
          openContradictions: 0,
          asks: 0,
          lastAskedAt: null,
          ...counts,
          scopeStale: drift?.stale ?? false,
          scopeLastMatchedAt: drift?.lastMatchedAt ?? null,
        },
        corroborations,
        contradictions: contradictions.map(
          (c): KnowledgeContradictionView => ({ ...c, amendment: store.getFact(c.amendmentId) }),
        ),
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
   * "nobody has agreed with this"; `committed` is absent because a fact leaves for
   * the repository through a documentation pull request, and setting the reach
   * here would take the claim out of every prompt while putting it nowhere. That
   * is `/commit` below, which opens the pull request, and the graduation sweep,
   * which moves the reach when it lands.
   */
  // Typed as the wire's own narrowing of `FactReach`, so the literals here and the
  // union the cockpit posts are one statement rather than two that agree today.
  const RULINGS: [FactRuling, ...FactRuling[]] = ['lookup', 'injected', 'retired', 'rejected'];
  const ReachBody = z.object({
    // One `errorMap` rather than the two stock messages, because a missing reach
    // and a reach nobody has heard of are the same mistake from the caller's side
    // — and zod's own enum wording names no field.
    reach: z.enum(RULINGS, {
      errorMap: () => ({
        message:
          'reach must be one of lookup (answered when an agent asks), injected (in front of every agent), ' +
          'retired (not carried any more, and may be raised again) or rejected (not true, and barred from ' +
          'coming back)',
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

  /**
   * Commit a claim to the repository: open the documentation work for it, and
   * record that it is on its way.
   *
   * **One call, because it is one act from the operator's side** — "this belongs in
   * the repository" is the decision, and opening the work and recording where it
   * went are its two halves. Two calls could half-land in both directions, and both
   * are silent: a documentation pull request nothing links to lands and takes the
   * claim out of no prompt, and a graduation naming no job draws a row on its way
   * to a repository nothing is writing it into. `Store.commitFact` makes both
   * writes in one transaction and this route is the only way to reach it.
   *
   * **It does not move the reach**, and that is the answer to what a fact is
   * between the click and the landing. The claim is still true, still injected or
   * still answerable, and still open to contradiction while its pull request sits
   * in review — because a claim taken out of every prompt the moment somebody
   * queues a docs job is a claim the fleet stops being told for a pull request that
   * may be closed unmerged, and then nobody is told it and nobody can read it. The
   * reach moves to `committed` when `KnowledgeGraduationDesk` reads the pull
   * request as merged, and never before.
   *
   * **Nothing auto-commits.** This is an operator's click and only an operator's,
   * for the reason `src/mcp/findings.ts` gives about `report_finding`: an agent
   * that could queue this work could put agents on the fleet, which is a capability
   * escalation rather than a convenience. It is the same authority
   * `POST /api/findings/:id/promote` exercises over a `docs` finding, over the same
   * machinery.
   */
  const CommitBody = z.discriminatedUnion('target', [
    // The ordinary answer, and the one that needs nothing said: `docs/README.md`
    // says which document owns what, and the agent reads it.
    z.object({ target: z.literal('spec') }),
    // The exception, priced like one. CLAUDE.md is loaded into every agent's
    // context on every dispatch and its length is asserted rather than intended, so
    // graduating there grows without bound the exact cost this design exists to
    // cap. The operator states what breaks *silently* without the claim — that file's
    // own bar — and the shape of the body is what makes it unskippable, the same
    // reason `narrowed` carries its claim rather than offering an optional field.
    // It is not ceremony: the sentence is appended to the agent's prompt, so
    // whoever writes the entry has the argument in the operator's words.
    z.object({
      target: z.literal('claudeMd'),
      bar: z
        .string()
        .trim()
        .min(
          1,
          'CLAUDE.md takes only what, not knowing it, gets something broken silently — say what breaks, and ' +
            'how it fails without anything going red. It is read by the agent writing the entry',
        )
        .max(MAX_CLAIM_CHARS),
    }),
  ]);
  app.post(
    '/api/knowledge/facts/:id/commit',
    checked({ params: IdParams, body: CommitBody }, async ({ params, body, reply }) => {
      const fact = store.getFact(params.id);
      if (!fact) return reply.code(404).send({ error: 'fact not found' });
      // What may be committed is the claim's own business rather than this route's
      // — a proposal nobody has agreed with, and a notice that ends by itself, are
      // both the wrong *kind* of thing to put in a tree. Stated once, next to the
      // rest of graduation's rules.
      const allowed = committableFact(fact);
      if (!allowed.ok) return reply.code(409).send({ error: allowed.error });
      // One at a time. A second docs job for a claim already being written up is two
      // agents writing the same paragraph into two pull requests, and whichever
      // landed first would settle a graduation the other one was still working.
      const inFlight = store.listGraduations().find((g) => g.factId === fact.id && g.outcome === null);
      if (inFlight) {
        return reply.code(409).send({
          error:
            'a documentation pull request for this claim is already open' +
            `${inFlight.prRef === null ? '' : ` (${inFlight.prRef})`} — wait for it to land, or say what became of it`,
        });
      }
      const { title, vars } = factDocsFields(fact);
      // The `docs-change` template a promoted `docs` finding already renders, and
      // deliberately not a second id: everything it says is as true of a
      // corroborated claim as of one agent's report, and an operator who overrode it
      // to say where documentation lives in their repository said that once. What
      // graduation adds is **appended** rather than interpolated, exactly as the
      // duplicate candidates are on `POST /api/findings/:id/file` — an override that
      // never learned about a new `{token}` drops it in silence, on precisely the
      // deployments that customised most.
      const prompt = [
        system.prompts.render('docs-change', vars),
        graduationNote(fact, body, store.listCorroborations(fact.id)),
      ].join('\n\n');
      const { job, graduation } = store.commitFact(fact, body, { title, prompt });
      hub.broadcast({ type: 'world:changed' });
      // Dispatched on this pulse rather than the next, `POST /api/findings/:id/promote`'s
      // shape: the operator clicked, and a queue that only moves on the heartbeat
      // reads as nothing having happened.
      const report = await harness.runCycle('manual');
      return { ok: true, fact, job, graduation, report };
    }),
  );

  /**
   * Say what became of a graduation the harness cannot read for itself.
   *
   * This is the `committed` verb the reach route deliberately does not carry, and
   * the objection that keeps it out of there does not apply here: the pull request
   * has already been opened, so saying it landed puts the claim in a place rather
   * than nowhere. Its opposite says the pull request is not happening, and leaves
   * the claim exactly where it was — still delivered, and committable again.
   *
   * It exists because the sweep will not guess. A pull request that vanished from
   * the world without ever being seen closed reads as merged only by *inference*,
   * and acting on that would take a claim out of every prompt for a pull request
   * that may have been closed unmerged while nothing was watching — so the harness
   * says `unknown` and asks the one party that can answer. Without this route that
   * reading would strand the graduation, and the claim would be drawn as on its way
   * to a repository forever.
   */
  const SettleBody = z.object({
    outcome: z.enum(['landed', 'abandoned'], {
      errorMap: () => ({
        message:
          'outcome must be landed (the pull request merged, so the claim is in the repository and leaves ' +
          'every prompt) or abandoned (it did not, so the claim stays exactly where it is)',
      }),
    }),
  });
  app.post(
    '/api/knowledge/graduations/:id/settle',
    checked({ params: IdParams, body: SettleBody }, async ({ params, body, reply }) => {
      const existing = store.getGraduation(params.id);
      if (!existing) return reply.code(404).send({ error: 'graduation not found' });
      const graduation = store.settleGraduation(params.id, body.outcome);
      // The one refusal: the sweep or an earlier click answered it first. A 409 and
      // never a throw — `setErrorHandler` means unanticipated, and this is
      // anticipated.
      if (!graduation) return reply.code(409).send({ error: 'this graduation has already been answered' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, graduation, fact: store.getFact(graduation.factId) };
    }),
  );

  /**
   * The three moves an operator has on a contradiction — **one route, because
   * adopting an amendment is one act**.
   *
   * Promoting the amendment and superseding the claim it replaces are two halves
   * of a single decision, and two calls can half-land: the sharper claim injected
   * beside the blunter one it was written to replace, both in the same block,
   * saying different things to every agent until somebody notices. So the store
   * makes both writes in one transaction and this route is the only way to reach
   * it.
   *
   * Nothing here files an amendment: an agent wrote that through
   * `knowledge_contradict`, on a scoped MCP credential, with an observation behind
   * it. What is decided here is which sentence stands.
   */
  const ResolveBody = z.discriminatedUnion('resolution', [
    // Adopt the agent's sentence, or say the dispute is wrong. Neither carries text.
    z.object({ resolution: z.literal('amended') }),
    z.object({ resolution: z.literal('dismissed') }),
    // Write the sharper sentence yourself. The claim is the whole of this move, so
    // it is required by the shape rather than checked in the handler — a narrowing
    // with nothing to narrow to is the one call here that could silently do nothing.
    z.object({
      resolution: z.literal('narrowed'),
      claim: z
        .string()
        .trim()
        .min(1, 'claim is what the fact should say instead — narrowing needs the sentence you are narrowing it to')
        .max(MAX_CLAIM_CHARS),
    }),
  ]);
  app.post(
    '/api/knowledge/contradictions/:id/resolve',
    checked({ params: IdParams, body: ResolveBody }, async ({ params, body, reply }) => {
      const outcome = store.resolveContradiction(params.id, body);
      if (outcome.outcome === 'unknown') return reply.code(404).send({ error: 'contradiction not found' });
      // A refusal is a returned 409 and never a throw: the store guards every write
      // regardless, so what reaches here is the wording for a decision that is no
      // longer available — already answered, or the claim already gone.
      if (outcome.outcome === 'refused') return reply.code(409).send({ error: outcome.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, fact: outcome.fact };
    }),
  );
}
