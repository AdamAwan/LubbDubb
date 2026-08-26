import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isCold } from '../../knowledge/cold.js';
import { checkScopeDrift, checkSightings } from '../../knowledge/drift.js';
import {
  exitableFact,
  factDocsFields,
  factJobRequest,
  factTicketFields,
  graduationNote,
} from '../../knowledge/graduation.js';
import { corroborationGoal, MAX_CLAIM_CHARS, validateFactProposal } from '../../knowledge/knowledge.js';
import { trackerCoordinates } from '../../mcp/findings.js';
import { dedupeCandidates, renderCandidates } from '../../tickets/candidates.js';
import type { FactExit, KnowledgeFact } from '../../types.js';
import type { FactRuling, KnowledgeContradictionView, KnowledgeFactPayload } from '../../wire.js';
import { checked, IdParams, optionalText, requiredText, TicketTitleBody } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * What the fleet knows about working this repository, as an operator reaches it
 * (issue #27 phase 2): the observations behind one claim, and the reach
 * transitions that are the whole of the governance.
 *
 * **Nothing here files a claim on an agent's behalf, and nothing promotes on
 * anybody's.** Agents raise through `raise`, on a scoped MCP credential rather
 * than the cockpit's bearer token; the store carries a claim to `lookup` on two
 * independent corroborations and no further, so `injected` is an operator's and
 * only an operator's, and a route that reached past `setFactReach` would be doing
 * what the store refuses to. The one write below that is not a ruling is an
 * operator typing a claim of their own, which lands a `proposal` like every other
 * — the gate is what it always was, and it is not a bypass for whoever happens to
 * be at the keyboard.
 *
 * **A rejection is terminal, so there is no un-reject route.** The bar is what
 * stops two agents re-proposing next week what an operator killed today; an
 * un-reject would be a way to lift it without reading the amendment that should
 * have lifted it. What comes back is an amendment naming the barred claim, filed
 * by the agent that found the sharper version — which is a tool call, not a click.
 *
 * There is no list route: the facts ride on `/api/state` with everything else the
 * cockpit polls, so the page draws them beside refs the snapshot's own link map
 * resolves. What does *not* ride there is the
 * evidence — thousands of characters per observation, on a polled snapshot — so
 * the provenance a reader opens a row for is fetched per fact below.
 *
 * → `docs/spec/27-knowledge.md`, `docs/spec/16-http-api.md`
 */
/**
 * What an operator's own claim carries as its observation.
 *
 * Stated once, as a constant, because it is written into `knowledge_corroborations`
 * where every other row holds an agent's own words — a reader comparing two rows
 * has to be able to tell "a person asserted this" from "an agent saw this", and a
 * sentence composed at the call site would be free to say something else next time.
 */
const OPERATOR_EVIDENCE = 'An operator wrote this down from what they already knew — no agent observed it.';

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
          // The fold's own reading, taken from the same counts the row above is —
          // the payload is what a reader opens, and a `cold` that disagreed with the
          // fold the reader clicked out of would be the row disagreeing with itself.
          cold: isCold(
            fact,
            { corroborations: counts?.corroborations ?? 0, asks: counts?.asks ?? 0 },
            {
              now: Date.now(),
              coldDays: system.config.knowledgeColdDays,
            },
          ),
        },
        corroborations,
        contradictions: contradictions.map(
          (c): KnowledgeContradictionView => ({ ...c, amendment: store.getFact(c.amendmentId) }),
        ),
      } satisfies KnowledgeFactPayload;
    }),
  );

  /**
   * The operator writing a claim down themselves — the one write on this page that
   * is not a ruling, and the arm `POST /api/lessons` used to be.
   *
   * **It lands a `proposal`, like everything else.** The surface is one gate, not
   * one gate and a bypass for whoever happens to be at the keyboard: an operator who
   * wants their own claim in front of the fleet promotes it afterwards, and that
   * second click is the same one they would make on an agent's. Nothing here is a
   * shortcut past corroboration either — a claim with one voice behind it is a claim
   * with one voice behind it, whoever the voice was.
   *
   * **The evidence is written by the harness and not asked for.** Every other
   * corroboration carries what its observer actually saw, and an operator typing
   * what they already know has no observation to give — a required field they have
   * nothing for comes back as "N/A", which is the shape `report_finding`'s optional
   * fields were argued into. What the row carries instead is the one true thing
   * about it: a person wrote it down, which is exactly what an operator reading the
   * provenance later needs to know about a claim no agent ever saw.
   *
   * `originRef` is the goal it was learned on, and it is optional because a claim
   * written from what an operator already knows has no goal behind it. A null there
   * is honest; a defaulted one would date the claim to work that did not teach it.
   */
  const ClaimBody = z.object({
    claim: requiredText('claim is required'),
    originRef: optionalText('originRef'),
  });
  app.post(
    '/api/knowledge/facts',
    checked({ body: ClaimBody }, async ({ body, reply }) => {
      const goalRef = corroborationGoal(body.originRef ?? null);
      // Bounded through the shared validator rather than here, which is the whole of
      // why `src/lessons.ts` existed and is now one file fewer: a bound written twice
      // drifts, and it drifts in the direction that matters — whichever writer is
      // looser decides what an operator ends up being asked to read.
      const parsed = validateFactProposal({ claim: body.claim, evidence: OPERATOR_EVIDENCE, scope: 'fleet' }, goalRef);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      // Attributed to nobody it does not have. A harness-written corroboration
      // carries the goal it was read on and no agent, task or session
      // (`KnowledgeNoticeDesk`'s rule); an operator's carries the same, because
      // there is no agent behind it either.
      const outcome = store.proposeFact(parsed.proposal, {
        agentId: null,
        taskId: null,
        goalRef,
        sessionId: null,
        words: OPERATOR_EVIDENCE,
      });
      // The bar holds for an operator too, and saying so is the point: they rejected
      // this claim, and the way back is an amendment naming it rather than typing it
      // again.
      if (outcome.outcome === 'barred') {
        return reply.code(409).send({
          error: `this claim was rejected (${outcome.barredBy.id}), and a rejection is terminal — the way back is an amendment naming it`,
        });
      }
      // `dirty` rather than `world:changed`: nothing in the world moved and no cycle
      // is run — the page simply has a row more to draw.
      hub.broadcast({ type: 'dirty' });
      return { ok: true, fact: outcome.fact };
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
      // The vouch is the pool's per-claim gate, so a ruling is what makes this
      // fleet's claims document stale. A **flag** and not a publish: a route that
      // did the network write would make the operator's click wait on a push to
      // another continent, and a failed push there would be a 500 on a ruling that
      // succeeded locally. The store write is the truth; the publish is a
      // consequence, and the desk's next pulse is where it happens.
      // → `docs/spec/28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler`
      store.markPoolDirty('claims');
      // `dirty` rather than `world:changed`: nothing in the world moved and no
      // cycle is run — the page simply has a row somewhere else. The reading
      // `dismissFinding` and `promoteLesson` both take.
      hub.broadcast({ type: 'dirty' });
      return { ok: true, fact };
    }),
  );

  /**
   * The three arms' one ending: write the job and the graduation together, and
   * dispatch on this pulse rather than the next.
   *
   * A queue that only moves on the heartbeat reads as nothing having happened,
   * which is `POST /api/findings/:id/promote`'s shape and its reason.
   */
  const send = async (fact: KnowledgeFact, exit: FactExit, work: { title: string; prompt: string }) => {
    const { job, graduation } = store.exitFact(fact, exit, work);
    hub.broadcast({ type: 'world:changed' });
    const report = await harness.runCycle('manual');
    return { ok: true, fact, job, graduation, report };
  };

  /**
   * Send a claim on: open the work that takes it somewhere, and record that it is
   * on its way.
   *
   * **One route for three exits, because it is one act from the operator's side** —
   * *this claim belongs somewhere other than in front of the fleet* — and because
   * the two it replaces were one act implemented twice, with the weaker one silent.
   * `POST /api/findings/:id/promote` stamped a status and never learned what became
   * of the job it queued; `POST /api/findings/:id/file` carried a ticket ref with
   * nothing watching whether the filing agent ever created one. Both are a
   * `knowledge_graduations` row now, which is the shape that already knew how to
   * end.
   *
   * **One call, because opening the work and recording where it went are two halves
   * of one decision.** Two calls could half-land in both directions, and both are
   * silent: work nothing links to lands and takes the claim out of no prompt, and a
   * graduation naming no job draws a row on its way somewhere nothing is taking it.
   * `Store.exitFact` makes both writes in one transaction and this route is the
   * only way to reach it.
   *
   * **It does not move the reach**, and that is the answer to what a fact is between
   * the click and the landing. The claim is still true, still injected or still
   * answerable, and still open to contradiction while its pull request sits in
   * review — because a claim taken out of every prompt the moment somebody queues a
   * job is a claim the fleet stops being told for work that may never land, and then
   * nobody is told it and nobody can read it. The reach moves to `graduated` when
   * the sweep reads the pull request as merged, or when the filing agent reports the
   * ticket it created, and never before.
   *
   * **Nothing auto-sends.** This is an operator's click and only an operator's: an
   * agent that could queue this work could put agents on the fleet, which is a
   * capability escalation rather than a convenience. That was `report_finding`'s
   * argument about promotion and it is unchanged by there being one store.
   */
  const ExitKind = z.object({
    exit: z.enum(['docs', 'job', 'ticket'], {
      errorMap: () => ({
        message:
          'exit must be one of docs (an agent writes the claim into the repository and opens a pull ' +
          'request), job (an agent works the claim now) or ticket (an agent writes it up and files it in ' +
          'the tracker, so it waits its turn)',
      }),
    }),
  });
  // The `docs` exit's own question, and the one arm of any of this that costs a
  // sentence. A discriminated union rather than an optional `bar` beside a free
  // target: CLAUDE.md is loaded into every agent's context on every dispatch and its
  // length is asserted rather than intended, so an arm that could be taken by
  // forgetting a field is the arm that gets taken.
  const DocsBody = z.discriminatedUnion('target', [
    // The ordinary answer, and the one that needs nothing said: `docs/README.md`
    // says which document owns what, and the agent reads it.
    z.object({ target: z.literal('spec') }),
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
  // The operator may reword what they queue before it runs; the derived text is
  // only the default. `TicketTitleBody` is the same override `/api/work/:ref/file`
  // offers over its own.
  const JobBody = z.object({ title: optionalText('title'), prompt: optionalText('prompt') });
  app.post(
    '/api/knowledge/facts/:id/exit',
    // Params first, then the store, then the body — the order a reader blames them
    // in: a claim that does not exist is a 404 whatever the body says, and this
    // file's nested `checked` is what puts the body's refusal second while keeping
    // it the same one refusal path as everywhere else.
    checked({ params: IdParams }, async ({ params, req, reply }) => {
      const fact = store.getFact(params.id);
      if (!fact) return reply.code(404).send({ error: 'fact not found' });
      return checked({ body: ExitKind }, async ({ body }) => {
        // What may be sent, and by which exit, is the claim's own business rather than
        // this route's — stated once, beside the rest of graduation's rules.
        const allowed = exitableFact(fact, body.exit);
        if (!allowed.ok) return reply.code(409).send({ error: allowed.error });
        // One at a time, whichever exit. Two agents writing the same paragraph into
        // two pull requests is two chances to land a half of it, and two jobs on one
        // claim is two agents on one piece of work — the thing every other gate in the
        // harness is built to stop.
        const inFlight = store.listGraduations().find((g) => g.factId === fact.id && g.outcome === null);
        if (inFlight) {
          return reply.code(409).send({
            error:
              `this claim is already on its way out by its ${inFlight.exit} exit` +
              `${inFlight.prRef === null ? '' : ` (${inFlight.prRef})`} — wait for it to land, or say what ` +
              `became of it`,
          });
        }
        // The arm's own body, read second so the two refusals are told apart: a claim
        // this exit will not take is a 409 whatever the body says. The nested
        // `checked` is this file's established shape for that.
        if (body.exit === 'docs') {
          return checked({ body: DocsBody }, async ({ body: docs }) => {
            const { title, vars } = factDocsFields(fact);
            // The `docs-change` template a promoted `docs` finding already rendered,
            // and deliberately not a second id: everything it says is as true of a
            // corroborated claim as of one agent's report, and an operator who
            // overrode it to say where documentation lives in their repository said
            // that once. What graduation adds is **appended** rather than
            // interpolated — an override that never learned about a new `{token}`
            // drops it in silence, on precisely the deployments that customised most.
            const prompt = [
              system.prompts.render('docs-change', vars),
              graduationNote(fact, { exit: 'docs', ...docs }, store.listCorroborations(fact.id)),
            ].join('\n\n');
            return send(fact, { exit: 'docs', ...docs }, { title, prompt });
          })(req, reply);
        }
        if (body.exit === 'job') {
          return checked({ body: JobBody }, async ({ body: job }) => {
            const derived = factJobRequest(fact, store.listCorroborations(fact.id));
            return send(
              fact,
              { exit: 'job' },
              { title: job.title ?? derived.title, prompt: job.prompt ?? derived.prompt },
            );
          })(req, reply);
        }
        // With no tracker configured there is nowhere to file — the same gate all four
        // filing arms ask. The cockpit hides the control in this case, so reaching
        // here means a direct call.
        const tracker = trackerCoordinates(system.config);
        if (!tracker) {
          return reply.code(409).send({
            error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)',
          });
        }
        return checked({ body: TicketTitleBody }, async ({ body: ticket }) => {
          const derived = factTicketFields(fact, tracker, store.listCorroborations(fact.id));
          // Rendered from the operator's template book, not built here: how a ticket
          // should be worded is exactly the sort of house style an override exists
          // for. The duplicate candidates are **appended** rather than given a
          // placeholder, so an override that never learned about them cannot silently
          // drop them.
          const candidates = renderCandidates(dedupeCandidates(store.listTrackerItems(), derived.vars.summary ?? ''));
          const prompt = [system.prompts.render('finding-ticket', derived.vars), candidates]
            .filter((part) => part !== null)
            .join('\n\n');
          return send(fact, { exit: 'ticket' }, { title: ticket.title ?? derived.title, prompt });
        })(req, reply);
      })(req, reply);
    }),
  );

  /**
   * Say what became of a graduation the harness cannot read for itself.
   *
   * This is the `graduated` verb the reach route deliberately does not carry, and
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
  // The union's own refusal, worded: zod's stock discriminator message lists the
  // literals and never names the field, and the 400 body drops paths.
  const RESOLUTION_REFUSAL = { message: "resolution must be 'amended', 'dismissed' or 'narrowed'" };
  const ResolveBody = z.discriminatedUnion(
    'resolution',
    [
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
    ],
    { errorMap: () => RESOLUTION_REFUSAL },
  );
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
