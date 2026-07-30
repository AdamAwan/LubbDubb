import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import type { System } from '../system.js';
import type { Issue, IssueAssay, IssueDelivery, Retrospective, ShortfallCause, WorldSnapshot } from '../types.js';
import { Hub } from './hub.js';
import { buildRefUrls, issueCommentRef } from './refUrls.js';
import { describeRunningConfig } from './runningConfig.js';
import { prHealth } from '../prHealth.js';
import { prAttentionStatus, type PrAttentionContext } from '../prAttention.js';
import { issuePickupStatus, type IssuePickupContext } from '../dispatcher/issuePickup.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import { DEFAULT_COOLDOWN } from '../dispatcher/dispatchCooldown.js';
import type { InjectableEvent } from '../connector/connector.js';
import type { IntegrationSelection } from '../integrations/integration.js';
import { DISPATCH_RULES } from '../dispatcher/rules.js';
import { findingJobRequest, findingTicketFields, trackerCoordinates } from '../mcp/findings.js';
import { unrecordedWork, workItemTicketFields } from '../graph/unrecorded.js';
import { isRecoveryVerdict } from '../agents/crashRecovery.js';
import { planProposalRef, rejectionSignalQuery } from '../proposals/proposals.js';
import { planOrigin } from '../plans/planning.js';
import { planIssueNumber } from '../plans/parts.js';
import { detectFileOverlaps } from '../fileOverlap.js';
import { deliveryHold, deliverySignalQuery } from '../delivery/delivery.js';
import { SHORTFALL_CAUSES } from '../delivery/shortfall.js';
import { assaySignalQuery, goalFingerprint } from '../intake/assay.js';
import { classifyCiFailures } from '../ci/ciPolicy.js';
import { watchLabelsFor } from '../watchLabels.js';
import {
  authRefusalHint,
  authorizeRequest,
  createAuthThrottle,
  describeAuthAttempt,
  resolveCockpitToken,
} from './auth.js';
import { debugLog } from '../debug.js';
import { mintArtifactCapability, verifyArtifactCapability } from './artifactCapability.js';
import { randomBytes } from 'node:crypto';

/**
 * Whether the configured world accepts synthetic events: only the `fake`
 * provider is injectable (`CompositeConnector.inject` records anything else as
 * `inject_unhandled`). Gates both the `/api/inject` route and the cockpit's
 * inject panel (via the state snapshot), so a real-integration deployment
 * doesn't expose a demo affordance.
 */
export function isWorldInjectable(integrations: IntegrationSelection): boolean {
  return Object.values(integrations).some((provider) => provider === 'fake');
}

/** Bind addresses that mean "this machine only" — the ones the Host check is sound for. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

interface BuiltApp {
  app: FastifyInstance;
  hub: Hub;
  /** The cockpit URL to open, token fragment included, or null when auth is off. */
  cockpitUrl: string | null;
  /** Where a minted token was persisted, for the banner. Null when it came from the env or auth is off. */
  tokenPath: string | null;
}

/**
 * Builds the cockpit HTTP + WebSocket surface. REST for actions and state,
 * WebSocket for live streaming, and (in production) the built SPA served from
 * `web/dist`. Returns the Fastify instance and the hub so `main.ts` can wire the
 * harness lifecycle around it and tests can drive it via `.inject()`, plus the
 * tokenised URL for the startup banner.
 */
export async function buildApp(system: System): Promise<BuiltApp> {
  const app = Fastify({ logger: false });
  const hub = new Hub(system);

  // Registered before every route and plugin below, because a Fastify hook is
  // inherited only by contexts created after it — the `/ws` route lives in a
  // child context, and adding this later would leave the live transcript stream
  // (source code, agent output) as the one unguarded surface.
  const auth = system.config.auth.enabled ? resolveCockpitToken(system.config.auth.tokenFile) : null;
  if (auth) {
    const requireLoopbackHost = LOOPBACK_HOSTS.has(system.config.host);
    // Only refusals are counted, so the cockpit's continuous state polling can
    // never throttle itself — the same reason rate limiting is registered
    // `global: false` below.
    const throttle = createAuthThrottle();
    // The *first* refusal of a run is recorded, and every one after it goes to
    // the opt-in debug log. A cockpit that cannot authenticate polls, so logging
    // each one would bury the only one that matters under thousands of copies of
    // itself — while logging none is how a stale bundle stays invisible through
    // restarts and hard refreshes. The first line names the cause; the flag is
    // there for when the cause changes between requests.
    let refused = false;
    app.addHook('onRequest', async (req, reply) => {
      const now = Date.now();
      const attempt = {
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
        queryToken:
          typeof (req.query as { t?: unknown } | undefined)?.t === 'string'
            ? (req.query as { t: string }).t
            : undefined,
      };
      const verdict = authorizeRequest(attempt, {
        token: auth.token,
        requireLoopbackHost,
        throttled: throttle.blocked(req.ip, now),
      });
      if (verdict.ok) return;
      throttle.fail(req.ip, now);
      const summary = `${verdict.code} ${verdict.error} — ${describeAuthAttempt(attempt)}`;
      if (refused) {
        debugLog('auth', summary);
      } else {
        refused = true;
        const hint = authRefusalHint(attempt);
        system.errors.record({
          source: 'server',
          message: 'cockpit refused a request — the first of this run',
          // JSON-encoded: every field in the summary is an attacker-controlled
          // header, and a newline in an Origin would otherwise forge a second,
          // fake log line. (`debugLog` does its own encoding.)
          detail: [
            JSON.stringify(summary),
            ...(hint ? [hint] : []),
            'Set LUBBDUBB_DEBUG=1 to log every refusal, not just the first.',
          ].join('\n'),
        });
      }
      // A refused *upgrade* needs its connection torn down explicitly. The client
      // asked to switch protocols and got an ordinary response instead, which
      // leaves a socket that belongs to neither side's bookkeeping — the HTTP
      // server no longer counts it, so `app.close()` waits on it forever and the
      // harness never shuts down. `Connection: close` makes node end it with the
      // response.
      if (req.headers.upgrade) {
        reply.header('connection', 'close');
        reply.raw.once('finish', () => reply.raw.socket?.destroy());
      }
      // Returning the reply is what tells Fastify the lifecycle is over —
      // without it the route handler still runs.
      return reply.code(verdict.code).send({ error: verdict.error });
    });
  }

  await app.register(websocket);
  // Opt-in rate limiting (`global: false`): only routes that set `config.rateLimit`
  // are limited, so the cockpit's frequent state polling is never throttled. The
  // artifact route opts in because it reads files off disk.
  await app.register(rateLimit, { global: false });

  const { store, connector, harness, agents, escalations, proposals, permissions, recovery, config, errors } = system;
  // The watch/ignore label pair the cockpit's toggles write and the gates read.
  const { watchLabel, ignoreLabel } = watchLabelsFor(config.labelPrefix);

  // Operator-configured absolute docsFolderPrefix entries are trusted roots the
  // artifact route may serve from, on top of each agent's worktree. Relative
  // entries add nothing here — they're already covered by the worktree root.
  const artifactRoots = absolutePrefixes(config.docsFolderPrefix);

  // How the artifact route authorizes a browser *navigation*. The `/artifacts`
  // route sits outside the `/api` prefix on purpose (see the route below), so the
  // bearer-token guard doesn't apply and it must authorize itself. It does so with
  // a per-flag capability: a fresh per-run secret signs `<flag id>.<expiry>`, the
  // signer mints one into every artifact URL the snapshot ships, and the route
  // verifies it against the flag id in its own path. A per-run key (not the cockpit
  // token) means a capability is never the cockpit token even derived. Null when
  // auth is off — the whole surface is then open by the operator's choice and
  // loopback-only, so there is nothing to verify against.
  const artifactKey = auth ? randomBytes(32) : null;
  const artifactSigner = artifactKey
    ? (flagId: string): string => mintArtifactCapability(artifactKey, flagId, Date.now() + ARTIFACT_CAP_TTL_MS)
    : undefined;

  // An unanticipated throw in a route must not vanish into a silent 500: record
  // it to the error log (which also mirrors it to stderr and streams it to the
  // cockpit), then return a plain 500.
  // fastify 5 types the handler's error as `unknown` — a route may throw a
  // non-Error, and the recorded message must not read as "undefined".
  app.setErrorHandler((err: unknown, req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    errors.record({
      source: 'server',
      message: `${req.method} ${req.url} failed: ${message}`,
      detail: err instanceof Error ? (err.stack ?? null) : null,
    });
    return reply.code(500).send({ error: message });
  });

  // -- Live stream ---------------------------------------------------------
  app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (socket) => {
      hub.add(socket);
      socket.on('message', (raw) => hub.handleClientMessage(socket, raw.toString()));
      socket.send(JSON.stringify({ type: 'dirty' }));
    });
  });

  // -- State ---------------------------------------------------------------
  app.get('/api/state', async () => buildStateSnapshot(system, { artifactSigner }));

  app.get('/api/agents/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = store.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'agent not found' });
    return { agentId: id, transcript: store.getTranscript(id) };
  });

  // Serve a local artifact an agent flagged (a design doc, a report), addressed by
  // its flag id. The path is taken from the *stored* flag row, not the request, so
  // a client can only fetch a ref an agent actually surfaced — and the served path
  // is confined to that agent's worktree or an operator-configured absolute
  // `docsFolderPrefix` root (a symlink or `..` that escapes every root is refused).
  // The response is sandboxed (CSP `sandbox`) so agent-authored HTML can't script
  // the cockpit's origin. Rate-limited since it reads off disk. URL flags aren't
  // served here; the cockpit links those directly.
  //
  // **This route lives outside the `/api` prefix on purpose (issue #129).** It is
  // reached by a top-level browser navigation — the operator clicks a chip, a new
  // tab opens here — and a navigation cannot set an `Authorization` header, only
  // `fetch` can. So the cockpit's bearer token (attached by hand to every `fetch`,
  // held in a fragment the browser never sends) structurally cannot reach a route
  // under `/api`, and the prefix guard would 401 it. Rather than carve an exception
  // *into* the guard — which would erode "guarded by prefix, not per-route opt-in"
  // — the route sits outside the prefix and authorizes itself with a per-flag
  // capability the navigation can carry in the query string (see
  // {@link ./artifactCapability.ts} for why that is not the cockpit token in a URL).
  app.get('/artifacts/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Capability first, before the flag is even looked up: it is bound to this id,
    // and refusing early keeps the route from confirming which flag ids exist to a
    // caller that holds no capability. Skipped only when auth is off (no key).
    if (artifactKey) {
      const tk = (req.query as { tk?: unknown })?.tk;
      if (typeof tk !== 'string' || !verifyArtifactCapability(artifactKey, tk, id, Date.now()))
        return reply.code(401).send({ error: 'missing or invalid artifact capability' });
    }
    const flag = store.getFlag(id);
    if (!flag) return reply.code(404).send({ error: 'artifact not found' });
    if (/^https?:\/\//i.test(flag.ref))
      return reply.code(400).send({ error: 'url refs are linked directly, not served' });
    const agent = store.getAgent(flag.agentId);
    if (!agent) return reply.code(404).send({ error: 'agent not found' });
    const file = resolveConfinedArtifact(agent.cwd, flag.ref, artifactRoots);
    if (!file) return reply.code(404).send({ error: 'artifact not found' });
    reply
      .header('content-type', artifactMime(file))
      .header('content-security-policy', 'sandbox allow-scripts allow-downloads')
      .header('x-content-type-options', 'nosniff');
    return reply.send(readFileSync(file));
  });

  // -- Actions -------------------------------------------------------------
  app.post('/api/inject', async (req, reply) => {
    // Defence in depth: the cockpit hides the panel, but the route itself also
    // refuses when no fake provider is configured to receive the event.
    if (!isWorldInjectable(config.integrations))
      return reply.code(403).send({ error: 'event injection is only available with fake integrations' });
    const event = req.body as InjectableEvent;
    if (!event || typeof event.kind !== 'string') return reply.code(400).send({ error: 'invalid event' });
    connector.inject(event);
    hub.broadcast({ type: 'world:changed' });
    // An injected event should provoke an immediate cycle.
    const report = await harness.runCycle('manual');
    return { ok: true, report };
  });

  app.post('/api/pulse', async () => {
    const report = await harness.runCycle('manual');
    return { ok: true, report };
  });

  // Clear the fault log. A POST like every other mutation on this surface, not a
  // DELETE: the auth hook and the structural route-table test that walks it both
  // key on the `/api` prefix, and one verb for one meaning is worth more here than
  // matching HTTP's. The `dirty` is what empties the panel in every open cockpit —
  // this is a delete, so a second one watching must not go on showing rows that
  // are gone.
  //
  // It opts into rate limiting for the same reason the artifact and work routes do
  // and `/api/state` does not: it writes the store on demand rather than on the
  // cockpit's poll, and a `DELETE` over a table with no bound on its row count is
  // unbounded work behind a fixed-size request. A clear is one deliberate two-step
  // click, so the ceiling sits far above any real interaction.
  app.post('/api/errors/clear', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => {
    const cleared = store.clearErrors();
    hub.broadcast({ type: 'dirty' });
    return { ok: true, cleared };
  });

  // Live dispatch controls (cap + pause). Changes are in-memory and ephemeral;
  // on success we broadcast so every open cockpit updates without a refetch.
  app.post('/api/control', async (req, reply) => {
    const body = (req.body ?? {}) as { cap?: unknown; paused?: unknown };
    const patch: { cap?: number; paused?: boolean } = {};
    if (body.cap !== undefined) {
      if (typeof body.cap !== 'number') return reply.code(400).send({ error: 'cap must be a number' });
      patch.cap = body.cap;
    }
    if (body.paused !== undefined) {
      if (typeof body.paused !== 'boolean') return reply.code(400).send({ error: 'paused must be a boolean' });
      patch.paused = body.paused;
    }
    try {
      const next = system.runtimeControl.apply(patch);
      hub.broadcast({ type: 'control:changed', cap: next.cap, paused: next.paused });
      return { ok: true, ...next };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Toggle the PR exclusion tag from the cockpit: add/remove the configured
  // exclusion label on the PR through the provider. The next snapshot reflects
  // the label and the harness leaves a tagged PR alone. Provider-agnostic — it
  // routes through the same outbound seam as replies/merges.
  app.post('/api/prs/:number/exclude', async (req, reply) => {
    const { number } = req.params as { number: string };
    const prNumber = Number(number);
    if (!Number.isInteger(prNumber)) return reply.code(400).send({ error: 'invalid PR number' });
    const { excluded } = (req.body ?? {}) as { excluded?: unknown };
    if (typeof excluded !== 'boolean') return reply.code(400).send({ error: 'excluded must be a boolean' });
    try {
      const result = await connector.setPrLabel({ prNumber, label: ignoreLabel, present: excluded });
      // Reflect the change immediately: refetch on the next state read, and run a
      // cycle so a now-included PR is picked up (or a now-excluded one dropped).
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, ref: result.ref, excluded };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Toggle an issue's watch/ignore state from the cockpit. Issues are opt-in, so
  // "watch" adds the watch tag (and clears any ignore tag) and "ignore" adds the
  // ignore tag (and clears the watch tag) — the write pair keeps the two labels
  // mutually exclusive. Provider-agnostic through the same outbound seam.
  app.post('/api/issues/:number/watch', async (req, reply) => {
    const { number } = req.params as { number: string };
    const issueNumber = Number(number);
    if (!Number.isInteger(issueNumber)) return reply.code(400).send({ error: 'invalid issue number' });
    const { watched } = (req.body ?? {}) as { watched?: unknown };
    if (typeof watched !== 'boolean') return reply.code(400).send({ error: 'watched must be a boolean' });
    try {
      await connector.setIssueLabel({ number: issueNumber, label: watchLabel, present: watched });
      await connector.setIssueLabel({ number: issueNumber, label: ignoreLabel, present: !watched });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, watched };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Set (or clear) an issue's conclusion by hand — the operator's override of what
  // the agent that worked it said, and of what its plan derives.
  //
  // It writes the *harness's* record, not the tracker: nothing here moves the work
  // item, because concluding an issue in the harness's own view is what stops the
  // re-pickup, while the tracker transition to a done state stays a human act (in
  // the workflow this was built for, a finished item is still waiting on test).
  // Rule 3b then reads the verdict on the next cycle, which is why `more_work`
  // runs one immediately — the operator's "no, there's more here" should bounce
  // the item back to pickup now rather than on the next heartbeat.
  app.post('/api/issues/:number/conclusion', async (req, reply) => {
    const { number } = req.params as { number: string };
    const issueNumber = Number(number);
    if (!Number.isInteger(issueNumber)) return reply.code(400).send({ error: 'invalid issue number' });
    const { verdict, note } = (req.body ?? {}) as { verdict?: unknown; note?: unknown };
    const originRef = issueConclusionOrigin(issueNumber);
    // null clears, returning the issue to whatever its plan derives (or to
    // undeclared) — a delete rather than a third stored verdict, so there is only
    // ever one way to express "nobody has decided this".
    if (verdict === null) {
      store.clearIssueConclusion(originRef);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, verdict: null };
    }
    if (verdict !== 'done' && verdict !== 'more_work') {
      return reply.code(400).send({ error: 'verdict must be "done", "more_work" or null' });
    }
    const conclusion = store.recordIssueConclusion({
      originRef,
      verdict,
      // An operator toggling from the cockpit has the row itself as context, so
      // unlike the tool a note is optional here; the default says who decided.
      note: typeof note === 'string' && note.trim() ? note.trim() : 'Set by the operator from the cockpit.',
      by: 'operator',
    });
    hub.broadcast({ type: 'world:changed' });
    if (verdict === 'more_work') await harness.runCycle('manual');
    return { ok: true, conclusion };
  });

  // Override a goal assay — the escape hatch a blocking gate has to have.
  //
  // `unclear` is the only verdict that stops anything, and it stops it for an issue
  // the operator has explicitly tagged for the harness. So the operator must be able
  // to say "work it anyway" without editing the ticket to say something they do not
  // mean, and must be able to say "no, this really is unworkable" without waiting for
  // an agent to agree. Both arms are here.
  //
  // Clearing is a delete rather than a stored third verdict, for `clearDelivery`'s
  // reason: the absence of an assay keeps exactly one representation, and it is
  // also the state a crashed assayer leaves behind — the fail-open. The goal
  // fingerprint of an operator's verdict is taken from the issue as the harness
  // currently sees it, so it expires on the next edit exactly as an agent's does.
  app.post('/api/issues/:number/assay', async (req, reply) => {
    const { number } = req.params as { number: string };
    const issueNumber = Number(number);
    if (!Number.isInteger(issueNumber)) return reply.code(400).send({ error: 'invalid issue number' });
    const { verdict, summary } = (req.body ?? {}) as { verdict?: unknown; summary?: unknown };
    if (verdict !== null && verdict !== 'workable' && verdict !== 'unclear') {
      return reply.code(400).send({ error: 'verdict must be "workable", "unclear" or null' });
    }
    const originRef = issueConclusionOrigin(issueNumber);
    if (verdict === null) {
      store.clearAssay(originRef);
      hub.broadcast({ type: 'world:changed' });
      // Clearing a hold is a request to reconsider the issue now, not next beat.
      await harness.runCycle('manual');
      return { ok: true, assay: null };
    }
    // The text the verdict is about, from the world the cockpit is showing. Absent
    // (an issue the last snapshot did not carry) is refused rather than guessed: a
    // verdict fingerprinted against an empty goal would expire the instant the
    // issue was next fetched, which is a silent no-op dressed as an override.
    const issue = store.getWorldBaseline()?.issues.find((i) => i.number === issueNumber);
    if (!issue) return reply.code(404).send({ error: 'issue not in the last world snapshot' });
    const assay = store.recordAssay({
      originRef,
      verdict,
      // As on the conclusion and delivery routes, an operator has the item in front
      // of them, so the summary is optional and the default says who decided.
      summary: typeof summary === 'string' && summary.trim() ? summary.trim() : 'Set by the operator from the cockpit.',
      goalRef: goalFingerprint(issue.title, issue.body),
      by: 'operator',
    });
    hub.broadcast({ type: 'world:changed' });
    // A `workable` override releases the issue into the funnel — act on it now.
    if (verdict === 'workable') await harness.runCycle('manual');
    return { ok: true, assay };
  });

  // Park an issue as delivered by hand, or release one the assessor parked.
  //
  // The operator's own arm of the same verdict rule 3e's assessor casts, and the
  // escape hatch for it — an operator looking at a finished issue must not have to
  // wait for an agent to agree, and one looking at a wrongly-parked issue must be
  // able to say so without moving the ticket. It writes the *harness's* record and
  // never the tracker: `delivered` is deliberately weaker than `closed`, and
  // closing the ticket stays a human act performed in the tracker itself.
  //
  // Clearing is a delete rather than a stored "not delivered", so the absence of a
  // verdict keeps exactly one representation — `clearIssueConclusion`'s reason.
  app.post('/api/issues/:number/delivered', async (req, reply) => {
    const { number } = req.params as { number: string };
    const issueNumber = Number(number);
    if (!Number.isInteger(issueNumber)) return reply.code(400).send({ error: 'invalid issue number' });
    const { delivered, summary } = (req.body ?? {}) as { delivered?: unknown; summary?: unknown };
    if (typeof delivered !== 'boolean') return reply.code(400).send({ error: 'delivered must be a boolean' });
    const originRef = issueConclusionOrigin(issueNumber);
    if (!delivered) {
      store.clearDelivery(originRef);
      hub.broadcast({ type: 'world:changed' });
      // Releasing a park is a request to reconsider the issue now, not next beat.
      await harness.runCycle('manual');
      return { ok: true, delivered: false };
    }
    const delivery = store.recordDelivery({
      originRef,
      // As on the conclusion route, an operator has the row in front of them, so
      // the summary is optional and the default says who decided.
      summary: typeof summary === 'string' && summary.trim() ? summary.trim() : 'Marked delivered by the operator.',
      by: 'operator',
    });
    hub.broadcast({ type: 'world:changed' });
    return { ok: true, delivery };
  });

  // Record by hand that an issue was worked and its goal is not reached, or clear
  // a standing shortfall.
  //
  // The operator's own arm of the assessor's negative verdict, and — more
  // importantly — the escape hatch it has to have. A shortfall lives until the arm
  // it named is performed, and *rejecting* the proposal deliberately leaves it
  // standing (the verdict is still true; you simply declined to act on it). So
  // without this the row and its chip would stand for good, with no way to say
  // "no, that is settled now" short of marking the issue delivered, which claims
  // something different.
  //
  // Clearing is a delete rather than a stored "no shortfall", for
  // `clearIssueConclusion`'s reason. Writing one clears any standing delivery, in
  // the store — the two are opposite answers to one question.
  app.post('/api/issues/:number/shortfall', async (req, reply) => {
    const { number } = req.params as { number: string };
    const issueNumber = Number(number);
    if (!Number.isInteger(issueNumber)) return reply.code(400).send({ error: 'invalid issue number' });
    const body = (req.body ?? {}) as { cause?: unknown; part?: unknown; summary?: unknown };
    const originRef = issueConclusionOrigin(issueNumber);
    if (body.cause === null) {
      store.clearShortfall(originRef);
      hub.broadcast({ type: 'world:changed' });
      // Clearing releases the rule that was about to ask about it — reconsider now.
      await harness.runCycle('manual');
      return { ok: true, shortfall: null };
    }
    if (body.cause !== undefined && !SHORTFALL_CAUSES.includes(body.cause as ShortfallCause))
      return reply.code(400).send({ error: `cause must be null or one of ${SHORTFALL_CAUSES.join(', ')}` });
    const cause = (body.cause as ShortfallCause | undefined) ?? null;
    if (cause === 'part' && (typeof body.part !== 'string' || !body.part.trim()))
      return reply.code(400).send({ error: 'cause "part" needs the part slug in `part`' });
    const shortfall = store.recordShortfall({
      originRef,
      cause,
      partSlug: typeof body.part === 'string' ? body.part.trim() : null,
      // As on the conclusion and delivery routes, an operator has the row in front
      // of them, so the summary is optional and the default says who decided.
      summary:
        typeof body.summary === 'string' && body.summary.trim()
          ? body.summary.trim()
          : 'Marked as not delivered by the operator.',
      by: 'operator',
    });
    hub.broadcast({ type: 'world:changed' });
    return { ok: true, shortfall };
  });

  // Toggle a story's watch/ignore state — same opt-in model as issues. Stories are
  // fake-backlog-only today, so this routes to the `StoryLabelCapable` fake provider.
  app.post('/api/stories/:id/watch', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { watched } = (req.body ?? {}) as { watched?: unknown };
    if (typeof watched !== 'boolean') return reply.code(400).send({ error: 'watched must be a boolean' });
    try {
      await connector.setStoryLabel({ id, label: watchLabel, present: watched });
      await connector.setStoryLabel({ id, label: ignoreLabel, present: !watched });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, watched };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Send a plan back for replanning. The mechanism already exists —
  // `resolvePlanRoute` routes a plan row in `planning` status to rule 3c — so this
  // is only the operator's way in: flip the status, and the next cycle dispatches a
  // planner primed with the current plan and part states (`issue-replan`).
  //
  // **Nothing is torn down.** Every part row is left exactly as it is: agents keep
  // running, branches stay, open PRs stay open. What an amended plan does to them is
  // decided at ingestion, where the planner's new declaration is actually known — a
  // part it no longer declares is retired only if nothing was started for it, and one
  // with a branch or a PR is kept whatever the amendment says (see `partsToRetire`).
  // Until that lands, the existing plan keeps scheduling: a replan that fails or is
  // never picked up leaves the issue exactly where it was, not parked.
  app.post('/api/plans/:id/replan', async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = store.getPlan(id);
    if (!plan) return reply.code(404).send({ error: 'plan not found' });
    let next = store.setPlanStatus(id, 'planning');
    // A replan also supersedes a running discussion — leaving `discussing` set
    // would have rule 3c render the `discuss-plan` template on its next dispatch
    // instead of the `issue-replan` one this call actually asked for, so the two
    // routes must agree about what plain `planning` means.
    if (next?.discussing) next = store.setPlanDiscussing(id, false);
    // A replan supersedes an approval that was still being asked for. Withdrawing
    // it is not optional: a pending proposal holds rule 3d off this plan, so the
    // amended verdict would never be put to anyone — and the stale card, if
    // accepted, would release a decomposition its reader never saw. The status
    // write above is what makes this safe to route through the ordinary reject:
    // the plan is no longer `awaiting_approval`, so `refusePlan` finds nothing to
    // settle and the withdrawal is only the inbox item closing.
    const ref = planProposalRef(plan.originRef);
    const pending = store.listProposals().find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
    if (pending) proposals.reject(pending.id, 'superseded by a replan');
    hub.broadcast({ type: 'world:changed' });
    await harness.runCycle('manual');
    return { ok: true, plan: next };
  });

  // Discuss a plan with an agent instead of accepting, rejecting or replanning it.
  //
  // Deliberately *a replan with a different prompt*, not a new mechanism: the plan
  // goes to `planning`, which is the status rule 3c already dispatches a planner
  // from, so the discussion agent inherits the origin gate (`issue:<n>:plan`, so no
  // second planner), the cooldown, the attempt cap and the fail-open — none of which
  // a bespoke path would have. `discussing` only picks the prompt.
  //
  // Nothing is scheduled while you talk: rule 4a schedules parts for `active` and
  // `awaiting_approval` plans only, and rule 3d proposes for `awaiting_approval`
  // only, so no fresh card appears mid-conversation either.
  //
  // **409 unless the plan is `awaiting_approval`.** Every framing of Discuss — the
  // design, this spec, the `discuss-plan` prompt itself ("before approving it") —
  // only ever contemplates talking through a decomposition that is still a pending
  // question. Starting from anywhere else manufactures an approval gate the plan
  // never had: a `single` verdict has no parts to approve, so ending an unguarded
  // discussion on one writes `awaiting_approval` over zero parts — rule 3d proposes
  // it, an operator approves an empty plan, `resolvePlanRoute` now returns `parts`
  // instead of `single`, and the issue is parked with no ready part, no agent and no
  // chip explaining why. Discussing an already-`active` plan is the milder version
  // of the same mistake: it reopens the gate rule 4a already cleared and stops
  // scheduling the remaining parts, which is exactly what `/discuss/end`'s own 409
  // exists to prevent on the way back out.
  app.post('/api/plans/:id/discuss', async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = store.getPlan(id);
    if (!plan) return reply.code(404).send({ error: 'plan not found' });
    if (plan.status !== 'awaiting_approval')
      return reply.code(409).send({ error: `plan ${id} is not awaiting approval (status: ${plan.status})` });
    // Order matters exactly as it does for a replan: the status write is what
    // makes the withdrawal safe, because `refusePlan` refuses to settle a plan
    // that is no longer `awaiting_approval` — so the reject below closes the inbox
    // item without retiring a single part.
    store.setPlanStatus(id, 'planning');
    const next = store.setPlanDiscussing(id, true);
    const ref = planProposalRef(plan.originRef);
    const pending = store.listProposals().find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
    if (pending) proposals.reject(pending.id, 'superseded by a discussion');
    hub.broadcast({ type: 'world:changed' });
    await harness.runCycle('manual');
    return { ok: true, plan: next };
  });

  // End a discussion the operator no longer wants — the escape hatch, since the
  // agent ends itself when it submits an amended plan.
  //
  // Restoring the status is half the job and not an afterthought: clearing the
  // flag alone leaves the plan in `planning`, which is precisely what rule 3c
  // dispatches from, so the next pulse would start another planner.
  app.post('/api/plans/:id/discuss/end', async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = store.getPlan(id);
    if (!plan) return reply.code(404).send({ error: 'plan not found' });
    // Compare-and-set against `discussing`, the same discipline `releasePlan` and
    // `refusePlan` apply to `awaiting_approval`: an unguarded restore would force
    // *any* plan back to `awaiting_approval` on a stale or duplicate call — a plan
    // already `active`, with parts dispatched and agents on branches, would have
    // its approval gate reopened and rule 4a would stop scheduling its parts. The
    // flag is exactly what says whether this call still names a live discussion.
    if (!plan.discussing) return reply.code(409).send({ error: `plan ${id} is not being discussed` });
    store.setPlanStatus(id, 'awaiting_approval');
    const next = store.setPlanDiscussing(id, false);
    // The plan restore is the important half and must not be undone by a completion
    // failure below — so a missing agent (already gone) or a `complete` that 409s
    // (already settled) is a no-op here, not a route failure. Left alive, the
    // planner keeps a fleet slot and a worktree with nothing to talk to (the
    // modal's discussion pane is gated on `plan.discussing`, so the reply box is
    // already gone), and a late `plan_submit` from that stale agent would revert
    // this very approval back to `awaiting_approval` a second time via ingestion.
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber !== null) {
      const task = store.findActiveTaskByOrigin(planOrigin(issueNumber));
      if (task?.agentId) agents.complete(task.agentId);
    }
    hub.broadcast({ type: 'world:changed' });
    await harness.runCycle('manual');
    return { ok: true, plan: next };
  });

  // Queue an operator-launched job. It persists as `queued` and is drained by
  // the dispatcher ahead of world-driven work — taking the next free slot, or
  // waiting in the queue when the fleet is at capacity. A cycle is kicked so a
  // job dispatches immediately when there's headroom.
  app.post('/api/jobs', async (req, reply) => {
    const body = (req.body ?? {}) as { prompt?: unknown; title?: unknown; kind?: unknown; branch?: unknown };
    if (typeof body.prompt !== 'string' || body.prompt.trim() === '')
      return reply.code(400).send({ error: 'prompt required' });
    const kind = body.kind ?? 'code';
    if (kind !== 'code' && kind !== 'desk') return reply.code(400).send({ error: "kind must be 'code' or 'desk'" });
    if (body.title !== undefined && typeof body.title !== 'string')
      return reply.code(400).send({ error: 'title must be a string' });
    if (body.branch !== undefined && body.branch !== null && typeof body.branch !== 'string')
      return reply.code(400).send({ error: 'branch must be a string' });
    const prompt = body.prompt.trim();
    const branch = (body.branch as string | undefined) ?? null;
    // Refuse a branch a live task already holds, up front (issue #116). The
    // executor's identical check is the real gate and stays — a branch can go busy
    // between queueing and dispatch, so this one can't be the only one — but a 409
    // now is worth far more to the operator than a deferral they'd have to read out
    // of the decision log hours later. The two cannot drift apart because they ask
    // `Store.findActiveTaskByBranch` the same question; where they differ is only in
    // *when*, which is why this one rejects (nothing has been promised yet) and the
    // executor's defers (a queued job the operator is entitled to have retried).
    // Only for code jobs: rule 0 ignores a desk job's branch entirely.
    if (kind === 'code' && branch) {
      const held = store.findActiveTaskByBranch(branch);
      if (held)
        return reply.code(409).send({
          error: `branch ${branch} is held by active task ${held.id}${held.originRef ? ` (${held.originRef})` : ''}`,
        });
    }
    // Fall back to a title derived from the prompt's first line when none is given.
    const title = (typeof body.title === 'string' && body.title.trim()) || deriveTitle(prompt);
    const job = store.createJob({ title, prompt, kind, branch });
    hub.broadcast({ type: 'world:changed' });
    const report = await harness.runCycle('manual');
    return { ok: true, job, report };
  });

  // Re-order the "Up next" queue (issue #128). The body is the operator's desired
  // priority order of candidate origins; it replaces the whole override set, ranked
  // 0..n-1. It only re-orders the dispatcher's ranking — it never un-holds a held
  // item, and rule-0 jobs stay first regardless — so it is safe to run a cycle
  // immediately so the new order takes effect and the next `/api/state` reflects it.
  app.post('/api/upnext/order', async (req, reply) => {
    const body = (req.body ?? {}) as { origins?: unknown };
    if (!Array.isArray(body.origins) || body.origins.some((o) => typeof o !== 'string'))
      return reply.code(400).send({ error: 'origins must be an array of strings' });
    const origins = body.origins as string[];
    // Guard against a duplicate origin: two ranks for one item is meaningless and
    // would make the persisted order depend on insertion accident.
    if (new Set(origins).size !== origins.length) return reply.code(400).send({ error: 'origins must be unique' });
    store.setPriorityOverrides(origins);
    hub.broadcast({ type: 'world:changed' });
    const report = await harness.runCycle('manual');
    return { ok: true, report };
  });

  // Drop a still-queued job before it runs. A job already dispatched can't be
  // cancelled here — kill its agent instead.
  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.cancelJob(id);
    if (!job) return reply.code(409).send({ error: 'job not found or no longer queued' });
    hub.broadcast({ type: 'world:changed' });
    return { ok: true, job };
  });

  // Promote a finding into work. **This is the only path from a finding to an
  // agent, and it starts with an operator's click** — an agent that could queue
  // jobs could put agents on the fleet (rule 0 dispatches a job ahead of every
  // world-driven rule), which is a capability escalation rather than a
  // convenience. So `report_finding` files a claim, and this route is where a
  // human turns one into work. See src/mcp/findings.ts for the full argument.
  app.post('/api/findings/:id/promote', async (req, reply) => {
    const { id } = req.params as { id: string };
    const finding = store.getFinding(id);
    if (!finding) return reply.code(404).send({ error: 'finding not found' });
    if (finding.status !== 'open') return reply.code(409).send({ error: `finding is already ${finding.status}` });
    const body = (req.body ?? {}) as { prompt?: unknown; title?: unknown; kind?: unknown };
    if (body.kind !== undefined && body.kind !== 'code' && body.kind !== 'desk')
      return reply.code(400).send({ error: "kind must be 'code' or 'desk'" });
    const derived = findingJobRequest(finding);
    // The operator may reword it before it runs; the derived text is only the default.
    const title = (typeof body.title === 'string' && body.title.trim()) || derived.title;
    const prompt = (typeof body.prompt === 'string' && body.prompt.trim()) || derived.prompt;
    const job = store.createJob({ title, prompt, kind: (body.kind as 'code' | 'desk' | undefined) ?? 'code' });
    // Resolve only after the job exists, so a failed create leaves the finding open.
    const resolved = store.resolveFinding(id, 'promoted', job.id);
    hub.broadcast({ type: 'world:changed' });
    const report = await harness.runCycle('manual');
    return { ok: true, finding: resolved, job, report };
  });

  // File a finding as a ticket in the tracker — the *defer* arm, next to promote's
  // "do it now". Both are one operator click and both produce a job, and the split
  // is what each job is for: promotion dispatches an agent at the problem, filing
  // dispatches one at the tracker so the problem can wait its turn with everything
  // else. Filing is asynchronous, so the finding lands on `filing` here and reaches
  // `filed` only when the agent reports the ticket back through `link_ticket`.
  app.post('/api/findings/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const finding = store.getFinding(id);
    if (!finding) return reply.code(404).send({ error: 'finding not found' });
    if (finding.status !== 'open') return reply.code(409).send({ error: `finding is already ${finding.status}` });
    // A desk agent runs in a scratch dir, so it has no remote to infer the target
    // from; without coordinates there is nowhere to file. The cockpit hides the
    // button in this case, so reaching here means a direct call.
    const tracker = trackerCoordinates(system.config);
    if (!tracker)
      return reply
        .code(409)
        .send({ error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)' });
    const derived = findingTicketFields(finding, tracker);
    const title =
      (typeof (req.body as { title?: unknown })?.title === 'string' &&
        ((req.body as { title?: string }).title ?? '').trim()) ||
      derived.title;
    // Rendered from the operator's template book, not built here: how a ticket
    // should be worded is exactly the sort of house style an override exists for.
    const prompt = system.prompts.render('finding-ticket', derived.vars);
    // Desk, not code: filing touches no repository, so a worktree and a branch
    // would be cut for a task that never writes a file.
    const job = store.createJob({ title, prompt, kind: 'desk' });
    // Job first, then resolve — a failed create leaves the finding open.
    const resolved = store.resolveFinding(id, 'filing', job.id);
    hub.broadcast({ type: 'world:changed' });
    const report = await harness.runCycle('manual');
    return { ok: true, finding: resolved, job, report };
  });

  // Dismiss a finding: the operator read it and it needs nothing. It stays in the
  // list (muted) rather than being deleted — "we looked at this" is information,
  // and a verbatim re-report is deduped onto the dismissed row rather than
  // reopening it.
  app.post('/api/findings/:id/dismiss', async (req, reply) => {
    const { id } = req.params as { id: string };
    const finding = store.resolveFinding(id, 'dismissed');
    if (!finding) return reply.code(409).send({ error: 'finding not found or already resolved' });
    hub.broadcast({ type: 'dirty' });
    return { ok: true, finding };
  });

  app.post('/api/escalations/:id/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { response } = (req.body ?? {}) as { response?: string };
    if (!response) return reply.code(400).send({ error: 'response required' });
    // An item carrying a pending proposal is a decision, not a question: free text
    // cannot be branched on, so answering one here would settle the inbox item
    // while leaving the proposal pending — which holds the rule that made it off
    // that PR for good. Refuse and name the two routes that do settle it.
    const pending = store.listProposals().find((p) => p.escalationId === id && p.status === 'pending');
    if (pending)
      return reply.code(409).send({
        error: `this item is a proposal (${pending.id}) — accept or reject it via /api/proposals/${pending.id}/accept|reject`,
      });
    // A permission request is the same shape of problem: the agent is blocked inside
    // a tool call, so free text can't be branched on and answering here would type
    // into a session that isn't at a prompt. Name the route that does settle it.
    const item = store.getEscalation(id);
    if (item?.context?.permission)
      return reply.code(409).send({
        error: `this item is a permission request — allow or deny it via /api/escalations/${id}/permission`,
      });
    // Third arm, same shape: the agent that asked this is dead and awaiting a
    // recovery verdict, so there is nothing to type into. Answering would route
    // nowhere and settle the item, losing the question — which the operator would
    // want back if they choose to restore.
    const orphaned = item?.agentId ? recovery.pendingForAgent(item.agentId) : null;
    if (orphaned)
      return reply.code(409).send({
        error:
          `the agent that asked this crashed — decide its recovery via ` +
          `/api/recovery/${orphaned.taskId} first (restore keeps this question open)`,
      });
    try {
      const result = escalations.answer(id, response);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Clear an alert without answering it. The gap this closes: an item raised
  // because an agent parked stays in "Needs you" even once the thing was handled
  // outside the harness, and the only way to empty it was to type a message nobody
  // wanted sent — least of all the agent, which has to interpret it.
  //
  // Available on *every* item, which means the two kinds that carry a verdict can't
  // simply be cleared: a permission request has an agent blocked inside a tool call
  // and a proposal has a rule held off a PR, so dropping the inbox row alone would
  // wedge one and strand the other. Each is routed to its own "no" instead — the
  // same call its Deny/Reject button makes — so "dismiss" means the same thing
  // everywhere (nothing goes out, nobody is left blocked) without a special case
  // that quietly does less than it says.
  app.post('/api/escalations/:id/dismiss', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { note } = (req.body ?? {}) as { note?: unknown };
    if (note !== undefined && typeof note !== 'string') return reply.code(400).send({ error: 'note must be a string' });
    const reason = typeof note === 'string' && note.trim() ? note.trim() : undefined;

    const pending = store.listProposals().find((p) => p.escalationId === id && p.status === 'pending');
    if (pending) {
      const result = proposals.reject(pending.id, reason);
      if (!result) return reply.code(409).send({ error: 'proposal not found or already decided' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, dismissedAs: 'proposal_rejected', proposal: result.proposal };
    }

    const item = store.getEscalation(id);
    if (item?.context?.permission && permissions.decide(id, false, reason)) {
      hub.broadcast({ type: 'dirty' });
      return { ok: true, dismissedAs: 'permission_denied' };
    }

    try {
      const escalation = escalations.dismiss(id, reason);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, dismissedAs: 'cleared', escalation };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Allow or deny a permission request an agent is blocked on (issue #130 phase B).
  // Resolves the blocked `--permission-prompt-tool` call with the operator's verdict
  // and settles the inbox item — the same live agent then continues (allow) or gets
  // the denial (deny), rather than being lost the way a config-and-restart was.
  app.post('/api/escalations/:id/permission', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { allow, note } = (req.body ?? {}) as { allow?: unknown; note?: unknown };
    if (typeof allow !== 'boolean') return reply.code(400).send({ error: 'allow (boolean) required' });
    if (note !== undefined && typeof note !== 'string') return reply.code(400).send({ error: 'note must be a string' });
    const decided = permissions.decide(id, allow, note);
    if (!decided) return reply.code(409).send({ error: 'no pending permission request for this escalation' });
    hub.broadcast({ type: 'dirty' });
    return { ok: true, allowed: allow };
  });

  // Accept a proposed act: the harness performs it, through the same `ActionSink`
  // it would have used had auto-send been on — this is the wire between "approve"
  // and "the approved thing happens" that issue #109 found missing. The verdict
  // transition is one-way, so a double-click merges once and the second call 409s.
  app.post('/api/proposals/:id/accept', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { note } = (req.body ?? {}) as { note?: unknown };
    if (note !== undefined && typeof note !== 'string') return reply.code(400).send({ error: 'note must be a string' });
    const result = await proposals.accept(id, note);
    if (!result) return reply.code(409).send({ error: 'proposal not found or already decided' });
    hub.broadcast({ type: 'world:changed' });
    return { ok: result.outcome !== 'failed', ...result };
  });

  // Reject it: nothing goes out, the reason is recorded, and the rule that
  // proposed it does not ask again (see `proposalHold`).
  app.post('/api/proposals/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { note } = (req.body ?? {}) as { note?: unknown };
    if (note !== undefined && typeof note !== 'string') return reply.code(400).send({ error: 'note must be a string' });
    const result = proposals.reject(id, note);
    if (!result) return reply.code(409).send({ error: 'proposal not found or already decided' });
    hub.broadcast({ type: 'dirty' });
    return { ok: true, ...result };
  });

  // Decide what happens to work the previous run left orphaned. **Until every
  // one of these is answered the harness runs no cycles at all**, so this route is
  // the only thing that can un-stick a booted-after-a-crash harness — which is why
  // it settles the verdict inline (like a proposal accept) rather than emitting an
  // action for a pulse that cannot run to pick up.
  //
  // A refusal is a 409 with the reason, and leaves the item pending: a restore the
  // runtime declines is not a decision, and the operator still has requeue and
  // remove. The cycle is kicked only once the *last* decision lands, since one
  // kicked while others are outstanding would just return the hold.
  //
  // `:id` is the **task** id, not the agent id: a restart can orphan a task before
  // its agent was ever spawned, and the task is the only identity every candidate has.
  app.post('/api/recovery/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { verdict } = (req.body ?? {}) as { verdict?: unknown };
    if (!isRecoveryVerdict(verdict))
      return reply.code(400).send({ error: "verdict must be 'restore', 'requeue' or 'remove'" });
    const result = recovery.decide(id, verdict);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    hub.broadcast({ type: 'world:changed' });
    const remaining = recovery.pendingCount();
    const report = remaining === 0 ? await harness.runCycle('manual') : undefined;
    return { ok: true, ...result.outcome, remaining, report };
  });

  app.post('/api/agents/:id/respond', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text) return reply.code(400).send({ error: 'text required' });
    const ok = agents.respond(id, text);
    return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
  });

  app.post('/api/agents/:id/kill', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = agents.kill(id);
    return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
  });

  // "This is finished" — the verdict only the agent could reach before, via the
  // done sentinel. Stops the process and records the clean terminal (task `done`,
  // worktree reclaimed on the reap), unlike kill, which records an abandonment.
  app.post('/api/agents/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = agents.complete(id);
    return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
  });

  app.post('/api/agents/:id/interrupt', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = agents.interrupt(id);
    return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
  });

  // -- Work graph ----------------------------------------------------------
  // Deliberately *not* folded into `/api/state`: that endpoint is polled
  // continuously, so shipping the whole forest on every poll is the wrong shape.
  // Roots are cheap; a subtree is fetched when a panel is opened. Both sit under
  // the `/api` prefix, so the `onRequest` guard above covers them with no
  // per-route opt-in.
  //
  // They *do* opt into rate limiting, for the same reason the artifact route does
  // and `/api/state` does not: both read the store on demand rather than on the
  // cockpit's poll, and the subtree walks a recursive CTE and resolves a URL per
  // node, so the cost is unbounded in the graph's size while the request is a
  // fixed-size string. Opening a panel spends one call, so the ceiling is far
  // above any real interaction.
  const WORK_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  // `unrecorded` rides on the roots read rather than taking a route of its own:
  // it is the same fetch-on-open the panel already makes, computed from rows it
  // is already reading. It is a lens — nothing in the dispatcher consults it.
  app.get('/api/work', WORK_RATE_LIMIT, async () => ({
    roots: store.listWorkRoots(),
    unrecorded: unrecordedWork(
      store.listWorkNodes(),
      store.listJobs(),
      store.listWorkItemFilings(),
      store.listWorkItemIgnores(),
    ),
  }));

  // The other verdict on the same row: no tracker item is wanted for this work.
  // A delete undoes it, so the panel can offer it back — an ignore that could only
  // be set would make an accidental click permanent, which is the wrong shape for
  // a lens whose whole content is the harness's own guess about what matters.
  app.post('/api/work/:ref/ignore', WORK_RATE_LIMIT, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    if (!store.listWorkNodes().some((n) => n.ref === ref)) return reply.code(404).send({ error: 'no such work item' });
    store.ignoreWorkItem(ref);
    return { ok: true };
  });

  app.delete('/api/work/:ref/ignore', WORK_RATE_LIMIT, async (req) => {
    const { ref } = req.params as { ref: string };
    store.unignoreWorkItem(ref);
    return { ok: true };
  });

  // File a work item for work the harness did that nothing external accounts for
  // — an operator job that produced commits with no issue anywhere behind it. The
  // mirror of `/api/findings/:id/file`, and an **operator click** for that route's
  // reason: creating tracker items on the harness's own initiative would be a new
  // outbound capability on the world, and the condition it fires on is permanent
  // until acted on, so a throttle would only set the rate at which a backlog
  // fills. See src/graph/unrecorded.ts for the full argument.
  app.post('/api/work/:ref/file', WORK_RATE_LIMIT, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const node = store.listWorkNodes().find((n) => n.ref === ref);
    if (!node) return reply.code(404).send({ error: 'no such work item' });

    const filings = store.listWorkItemFilings();
    const standing = filings.find((f) => f.targetRef === ref);
    if (standing)
      return reply.code(409).send({
        error:
          standing.status === 'filing'
            ? 'an agent is already filing a work item for this'
            : `already filed as ${standing.ticketRef}`,
      });
    // Asked of the same predicate the panel draws from, so the route can never
    // refuse what the button offered — including the ignore, which the predicate
    // carries rather than filters precisely so both surfaces read one verdict.
    const [entry] = unrecordedWork([node], store.listJobs(), filings, store.listWorkItemIgnores());
    if (!entry) return reply.code(409).send({ error: `${ref} is not unrecorded work — it has a work item already` });
    if (entry.ignored) return reply.code(409).send({ error: `${ref} is ignored — un-ignore it before filing` });

    // A desk agent runs in a scratch dir with no remote to infer the target from;
    // without coordinates there is nowhere to file. The cockpit hides the button
    // in this case, so reaching here means a direct call.
    const tracker = trackerCoordinates(system.config);
    if (!tracker)
      return reply
        .code(409)
        .send({ error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)' });

    const derived = workItemTicketFields(node, store.listWorkSubtree(ref), tracker);
    const title =
      (typeof (req.body as { title?: unknown })?.title === 'string' &&
        ((req.body as { title?: string }).title ?? '').trim()) ||
      derived.title;
    // Rendered from the operator's template book, not built here: how a work item
    // should be worded is exactly the sort of house style an override exists for.
    const prompt = system.prompts.render('work-item-ticket', derived.vars);
    // Desk, not code: filing touches no repository. It is also what stops this
    // recursing — a desk job is never itself unrecorded work.
    const job = store.createJob({ title, prompt, kind: 'desk' });
    // Job first, then the filing row — a failed create leaves the node unfiled.
    const filing = store.createWorkItemFiling({ targetRef: ref, jobId: job.id });
    hub.broadcast({ type: 'world:changed' });
    const report = await harness.runCycle('manual');
    return { ok: true, filing, job, report };
  });

  app.get('/api/work/:ref', WORK_RATE_LIMIT, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const nodes = store.listWorkSubtree(ref);
    if (nodes.length === 0) return reply.code(404).send({ error: 'no such work item' });
    // Resolved here rather than read off the snapshot's `refUrls`: that map is
    // built from the world, and a PR the graph remembers merging left the world
    // hours ago — the connector can still name its URL.
    const refUrls: Record<string, string> = {};
    for (const node of nodes) {
      const url = connector.resolveRefUrl(node.ref);
      if (url) refUrls[node.ref] = url;
    }
    return { nodes, refUrls };
  });

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
  // The document itself, fetched when a reader opens it rather than shipped on
  // every poll. Null rather than 404 for a goal nobody wrote up: "no retrospective"
  // is an ordinary answer here, not a missing resource.
  app.get('/api/retrospectives/:ref', async (req) => {
    const { ref } = req.params as { ref: string };
    return { retrospective: store.getRetrospective(ref) };
  });

  app.get('/api/prompts', async () => ({
    dir: config.promptTemplatesDir ?? null,
    // The `claude` dispatcher composes its prompts via the LLM and reads none of
    // this. The cockpit says so rather than drawing a book that never fires.
    dispatcher: config.dispatcher,
    templates: system.prompts.describe(),
  }));

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
  app.get('/api/config', async () => ({ groups: describeRunningConfig(config) }));

  app.get('/api/health', async () => ({ ok: true, dispatcher: config.dispatcher }));

  // -- Static SPA (production build) --------------------------------------
  const distDir = resolve(process.cwd(), 'web/dist');
  if (existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  // `0.0.0.0` is a bind address, not somewhere to point a browser; a URL built
  // from it lands nowhere. Loopback is the honest thing to print in that case —
  // the operator exposing the port knows their own hostname, and the token in the
  // fragment is what actually matters to them.
  const urlHost = LOOPBACK_HOSTS.has(config.host) ? config.host : '127.0.0.1';
  return {
    app,
    hub,
    cockpitUrl: auth ? `http://${urlHost}:${config.port}/#t=${auth.token}` : null,
    tokenPath: auth?.source === 'minted' ? auth.path : null,
  };
}

/**
 * Resolve a flagged artifact `ref` to an absolute path within one of the allowed
 * roots — the agent's worktree `cwd` plus any operator-configured `trustedRoots`
 * (the absolute `docsFolderPrefix` entries) — or null if it doesn't exist, isn't a
 * regular file, or escapes every root (via `..` or a symlink). A relative ref is
 * resolved against `cwd`; an absolute ref is honoured only if it lands inside a
 * trusted root. Two guards: a *lexical* containment check against some root runs
 * before any filesystem access, then `realpathSync` on both sides defeats symlink
 * traversal.
 */
function resolveConfinedArtifact(cwd: string, ref: string, trustedRoots: string[]): string | null {
  // A relative ref is worktree-relative; an absolute ref must land inside one of
  // the operator-configured absolute prefixes (its own trusted root). The
  // worktree cwd is always a trusted root. Serving re-validates containment here
  // independently of the flag, so an odd stored ref can't read outside a root.
  const target = isAbsolute(ref) ? resolve(ref) : resolve(cwd, ref);
  const roots = [cwd, ...trustedRoots];
  // Lexical containment against *some* root, before touching the filesystem.
  if (!roots.some((root) => target === root || target.startsWith(root + sep))) return null;
  try {
    const real = realpathSync(target);
    // Real-path containment: a symlink inside a root can't point outside it.
    const contained = roots.some((root) => {
      const realRoot = realpathSync(root);
      return real === realRoot || real.startsWith(realRoot + sep);
    });
    if (!contained) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null; // missing path, broken symlink, permission error — treat as not found
  }
}

/** The absolute entries of `docsFolderPrefix` — the extra trusted roots the artifact route may serve from. */
export function absolutePrefixes(docsFolderPrefix?: string | string[]): string[] {
  if (docsFolderPrefix === undefined) return [];
  const list = Array.isArray(docsFolderPrefix) ? docsFolderPrefix : [docsFolderPrefix];
  return list.filter((p) => isAbsolute(p)).map((p) => resolve(p));
}

/**
 * How long an artifact capability lives. Short, because a capability travels in a
 * URL (the one place a navigation can carry it) and a URL is the leakiest transport
 * we have. Long enough to comfortably outlast the gap between a state poll minting
 * the URL and the operator clicking it: the snapshot re-mints on every poll, so a
 * click is almost always against a capability seconds old, and even a backgrounded
 * tab's stale chip stays clickable for a few minutes.
 */
const ARTIFACT_CAP_TTL_MS = 5 * 60_000;

/** Build the `flag id → artifact URL` map the cockpit opens chips from. */
function artifactUrls(
  flags: { id: string; ref: string }[],
  signer?: (flagId: string) => string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const flag of flags) {
    // http(s) refs are linked directly by the cockpit and never served here.
    if (/^https?:\/\//i.test(flag.ref)) continue;
    const base = `/artifacts/${encodeURIComponent(flag.id)}`;
    // A signer is present exactly when auth is on. Off, the route needs no
    // capability, so the bare path is the whole URL.
    map[flag.id] = signer ? `${base}?tk=${encodeURIComponent(signer(flag.id))}` : base;
  }
  return map;
}

const ARTIFACT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

/** Content type for a served artifact, by extension; opaque octet-stream otherwise. */
function artifactMime(file: string): string {
  return ARTIFACT_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The world the cockpit draws: the baseline the last pulse persisted, **never a
 * fresh provider fetch**. `connector.getState()` is a fan-out — for `azure`,
 * `2 + 3N` REST calls for `N` open PRs — and the cockpit refetches this snapshot
 * on every `dirty`, one of which rides *every file an agent writes*. Reading the
 * provider here made the request rate a function of agent tool-call volume and
 * of how many cockpit tabs were open, which is a rate-limit block waiting to
 * happen. So the pulse is the only provider reader, and this is its record.
 *
 * Two properties make the substitution sound. The baseline is written *before*
 * the dispatch world is filtered (`Harness.runCycle`), so it is the **unfiltered**
 * world and an `-ignore`d PR stays visible here with its health — the very reason
 * this read the connector directly. And it is a pulse old, so it says so:
 * `worldObservedAt` is the reading's age, exactly as `world_read` reports
 * `observedAt` to an agent.
 *
 * A missing baseline (before the first cycle) ships an **empty** world rather
 * than falling back to a live fetch. The fallback is the obvious move and is
 * wrong: boot while the provider is throttling and the boot cycle fails, so the
 * baseline is never written, so every `dirty` refetches, fans out, fails, records
 * an error — which broadcasts another `dirty`. Unbounded, and worst exactly when
 * the provider is already refusing us. An empty world cannot do that.
 */
export function buildStateSnapshot(system: System, opts?: { artifactSigner?: (flagId: string) => string }) {
  const { store, connector, config, runtimeControl, harness, recovery } = system;
  const { watchLabel, ignoreLabel } = watchLabelsFor(config.labelPrefix);
  const baseline = store.getWorldBaseline();
  const world: WorldSnapshot = baseline ?? {
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
    stories: [],
  };
  const tasks = store.listTasks();
  const control = runtimeControl.snapshot();
  // Hoisted (not inlined into the returned object) because the artifact-URL map
  // below is derived from the same list.
  const flags = store.listAllFlags();
  // What agents noticed outside their own tasks. Read here (not only in the
  // panel) because their refs feed the link map below: a finding often names an
  // item that is *not* in the current world — a closed duplicate, say — so its
  // ref has to be resolved directly rather than looked up off the snapshot.
  const findings = store.listFindings();
  // Acts put to a human. Read here for the same reason as findings: a proposal's
  // ref (`pr:42:merge`) names the item its card links to, so it feeds the link
  // map below as well as the cards themselves.
  const proposals = store.listProposals();
  // Every file every agent wrote, read once: the drawer groups it by agent, and
  // the overlap detector below joins it *across* agents — the one question the
  // rows could always answer and nothing ever asked.
  const files = store.listAllFiles();
  // The plan graph, read once and shared by the per-issue pickup verdict below
  // and the snapshot itself, so the chip and the panel can't disagree.
  const plans = store.listPlans();
  const planParts = store.listAllPlanParts();
  // The same rows, translated for the wire (#171). The plan reconciler's one
  // living status comment is stored as a **provider comment id**, which is what
  // `upsertIssueComment` round-trips and exactly what the cockpit must not hold:
  // an id resolves to nothing on its own, and a bare number reads as an *issue
  // number* to `githubRefUrl`. `issueCommentRef` pairs it with the issue it lives
  // on, so the ref shipped here is one `refUrls` can answer — and the same
  // function feeds that map below, so the key and the lookup cannot disagree.
  const wirePlans = plans.map((p) => ({ ...p, statusCommentRef: issueCommentRef(p.originRef, p.statusCommentRef) }));
  // Standing "is this issue finished" verdicts, keyed on the issue origin — the
  // same rows rule 3b reads, so the chip and the rule can't disagree.
  const conclusions = new Map(store.listIssueConclusions().map((c) => [c.originRef, c]));
  const deliveries = store.listDeliveries();
  const deliveriesByOrigin = new Map(deliveries.map((d) => [d.originRef, d]));
  const deliveryWindow = deliverySignalQuery(deliveries);
  // The negative mirror, keyed the same way — the rows rule `issue-shortfall`
  // reads, so the chip and the rule cannot disagree about what fell short.
  const shortfalls = store.listShortfalls();
  const shortfallsByOrigin = new Map(shortfalls.map((s) => [s.originRef, s]));
  const assays = store.listAssays();
  const assayWindow = assaySignalQuery(assays);
  // Keyed the same way the conclusion and shortfall maps below are, so the
  // per-issue verdict beside them reads off one lookup.
  const assaysByOrigin = new Map(assays.map((a) => [a.originRef, a]));
  // The same inputs rule 4 of the dispatcher consults, so the per-issue verdict
  // below predicts what actually happens next cycle. The decision window (200)
  // and the headroom arithmetic mirror `Harness.runCycle`.
  const pickupCtx: IssuePickupContext = {
    policy: system.issuePickup,
    cooldown: DEFAULT_COOLDOWN,
    now: world.takenAt,
    tasks,
    recentDecisions: store.listDecisions(200),
    // Unfiltered on purpose: an `-ignore` tagged PR is hidden from dispatch but
    // is still an open PR, so it still parks its issue (see `openPrForIssue`).
    openPrs: world.pullRequests,
    // Same plan inputs rules 3c/4 read, so the chip explains an issue parked in
    // the funnel rather than claiming it's eligible for a pickup that won't fire.
    plans,
    planParts,
    planning: config.planning,
    // The harness's own park, read the same way `Harness.runCycle` reads it — the
    // event query is null (and no read happens) until an issue has been assessed.
    deliveries,
    deliverySignals: deliveryWindow ? store.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs) : [],
    // The content gate in front of the funnel, read exactly as `Harness.runCycle`
    // reads it — including the policy, so the chip reports an issue *awaiting* an
    // assay rather than calling it eligible for a pickup that will not fire.
    assays,
    assaySignals: assayWindow ? store.listWorldEventsSince(assayWindow.since, assayWindow.refs) : [],
    assay: config.assay,
    headroom: control.paused ? 0 : Math.max(0, control.cap - store.countLiveAgents()),
    paused: control.paused,
  };
  // The PR-side sibling: whose turn each PR is on. Asked off the same predicates
  // the rules ask, including the rejection expiry — the query is null (and the
  // read never happens) until an operator has actually rejected something, which
  // is the same shape `Harness.runCycle` and the executor use.
  const signals = rejectionSignalQuery(proposals);
  const attentionCtx: PrAttentionContext = {
    // Unfiltered, exactly as `inheritedCiFailure`/`basePrOf` need it (and as the
    // pickup context above takes it): an `-ignore`d base still attributes.
    openPrs: world.pullRequests,
    defaultBranch: config.defaultBranch,
    ignoreLabel,
    tasks,
    proposals,
    rejectionSignals: signals ? store.listWorldEventsSince(signals.since, signals.refs) : [],
    recentDecisions: pickupCtx.recentDecisions,
    cooldown: DEFAULT_COOLDOWN,
    // The same policy the dispatcher holds, so `attention` names the court rule 1
    // will act in rather than promising an agent for a check the policy holds.
    ci: config.ci,
    now: world.takenAt,
  };
  // The provider builds every URL (see CompositeConnector.resolveRefUrl); the
  // cockpit only looks refs up in this map, so it stays provider-agnostic.
  const refUrls = buildRefUrls({
    // Closed PRs are linked from the cockpit's "recently closed" list, so their
    // `#n` needs a URL too — the ref map is what the UI looks numbers up in.
    pullRequests: [...world.pullRequests, ...(world.closedPullRequests ?? [])],
    issues: world.issues,
    taskBranches: tasks.map((t) => t.branch),
    // A filed ticket is brand new, so it is usually *not* in the world lists the
    // `#n` keys are built from — it needs resolving by its canonical ref or the
    // chip the operator just created links nowhere.
    refs: [
      ...findings.map((f) => f.ref),
      ...findings.map((f) => f.ticketRef),
      ...proposals.map((p) => p.ref),
      // The comments the harness maintains on a ticket without being asked — the
      // plan's status comment and the assay's refusal (#171). Read off the values
      // actually shipped (and off the same `issueCommentRef` for the assay), so a
      // ref the cockpit holds is always the ref this map was keyed by. A provider
      // that resolves neither leaves them absent, and the cockpit draws nothing.
      ...wirePlans.map((p) => p.statusCommentRef),
      ...assays.map((a) => issueCommentRef(a.originRef, a.commentRef)),
    ],
    resolve: (ref) => connector.resolveRefUrl(ref),
  });
  return {
    config: {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxConcurrentAgents: config.maxConcurrentAgents,
      dispatcher: config.dispatcher,
      steeringPriorities: config.steeringPriorities,
      // The watch/ignore tag pair, so the cockpit knows which labels its toggles
      // set and how to render an item's effective watched/ignored state.
      watchLabel,
      ignoreLabel,
      // Whether the inject panel should render: synthetic events only land on
      // the `fake` provider, so real-integration deployments hide it.
      injectable: isWorldInjectable(config.integrations),
      // Whether a finding can be filed as a ticket at all — there is nowhere to
      // file one under the `fake` provider. Shipped as a flag rather than left to
      // the cockpit to infer from the provider name, so the one place that
      // decides is the one the route asks.
      canFileTickets: trackerCoordinates(config) !== null,
    },
    // When the world below was actually observed — null before the first cycle,
    // when there is no baseline and the lists are empty. Shipped because the
    // reading is a pulse old rather than live (see this function's contract), the
    // same reason `world_read` hands an agent an `observedAt`.
    worldObservedAt: baseline?.takenAt ?? null,
    // Live, mutable dispatch controls — the cockpit reads these (not the frozen
    // config block above) for the current cap and pause state.
    control,
    // Agents the previous run left orphaned, each awaiting restore / requeue /
    // remove. A non-empty list means the harness is running **no cycles**, which
    // is why the cockpit draws it as a blocking banner rather than one more
    // panel: the absence of activity everywhere else has exactly one cause, and
    // it is this.
    recovery: recovery.pending(),
    // Fold each PR's signals into a health verdict, and each issue's gates into
    // a pickup verdict, so the cockpit can show *why* an item is stuck or
    // untouched rather than leaving it implied by the absence of activity.
    world: {
      ...world,
      // The full open-PR list is passed as stack context so an inherited CI
      // failure names the PR underneath — otherwise a stacked PR reads as
      // "CI failing" with no agent on it and no visible reason why.
      //
      // `attention` sits beside `health`, not inside it: health answers "can this
      // merge" and attention answers "whose turn is it", and the two have
      // different right answers for the same PR (see `src/prAttention.ts`).
      pullRequests: world.pullRequests.map((pr) => ({
        ...pr,
        health: prHealth(pr, world.pullRequests),
        attention: prAttentionStatus(pr, attentionCtx),
        // The third verdict beside the other two, and it exists for the same
        // reason they are computed here rather than in the browser: the
        // alternative is shipping `config.ci` and re-matching client-side, which
        // means a second glob matcher and a second first-match-wins ordering
        // sitting nowhere near the rule they duplicate. That drift would fail
        // silently — the cockpit saying *repair* while the harness held. Same
        // call the dispatcher makes, off the same policy.
        ciVerdict: classifyCiFailures(pr.ciChecks, config.ci),
      })),
      // `conclusion` sits beside `pickup` and does not feed it — the same
      // relationship `attention` has to `health` above. Pickup answers "would an
      // agent start on this next cycle", which the work-item state already
      // decides; conclusion answers "has anyone said this is finished", which is
      // what rule 3b reads and what the operator toggles. Folding the second into
      // the first would make a `done` verdict silently veto an item the operator
      // had deliberately moved back to a pickup state.
      issues: world.issues.map((issue) => ({
        ...issue,
        pickup: issuePickupStatus(issue, pickupCtx),
        conclusion: resolveIssueConclusion(
          conclusions.get(issueConclusionOrigin(issue.number)) ?? null,
          plans.find((p) => p.originRef === issueConclusionOrigin(issue.number)) ?? null,
          shortfallsByOrigin.get(issueConclusionOrigin(issue.number)) ?? null,
        ),
        // Beside the conclusion and the pickup verdict, never inside either, for
        // the reason `attention` sits beside `health`: pickup answers "would an
        // agent start on this next cycle", and a shortfall's answer to that is
        // "yes, and that is the point". What this adds is *what fell short* and
        // what the harness has offered to do about it, which neither of the other
        // two can say.
        shortfall: shortfallsByOrigin.get(issueConclusionOrigin(issue.number)) ?? null,
        // The positive mirror, and the one verdict that reached no surface at all
        // until now. It cannot ride on either of its neighbours: after the
        // two-record split the assessor's `delivered` lives in its own table, so
        // `resolveIssueConclusion` above resolves a delivered *decomposed* issue to
        // `{by: 'plan'}`, and `issuePickupStatus` answers its plan `parts` arm
        // before the delivery park, so the same issue reports `planning`. Both are
        // honest about the questions they were asked; neither answers this one.
        delivery: standingDelivery(deliveriesByOrigin.get(issueConclusionOrigin(issue.number)), issue, pickupCtx),
        // The intake verdict, beside the other two for their reason and inside
        // `pickup` for none: pickup answers "would an agent start next cycle",
        // the assay answers "is there anything here to start on". `pickup.reasons`
        // already carries the refusal *text*, but "refused" and "awaiting a
        // verdict" differ only in that prose — and telling them apart by reading
        // a human-facing string is what `signalPolarity` refuses to do. So the
        // discriminator is structural. `goalRef` is deliberately not shipped: it
        // is a fingerprint the hold is measured against, not a reading.
        assay: assayVerdictOf(assaysByOrigin.get(issueConclusionOrigin(issue.number))),
        // The run's own write-up (rule 3h) — the **reading**, never the writing.
        // This snapshot is polled continuously, so a document per issue would be
        // paid for on every poll; `GET /api/retrospectives/:ref` serves the rest
        // when a reader actually opens it, the `WorkTreePanel` pattern.
        retrospective: retroReading(store.getRetrospective(issueConclusionOrigin(issue.number))),
      })),
    },
    // The plan graph, which until now existed only in the database: the per-issue
    // chip could say "2/5 parts merged" and nothing could say *which* five. The
    // cockpit joins parts to `upcoming` by origin to draw the dispatch cut.
    plans: wirePlans,
    planParts,
    tasks,
    // Operator-launched jobs (newest first) — the cockpit shows the queued
    // ones and their place in line, plus recently-dispatched/cancelled history.
    jobs: store.listJobs(),
    agents: store.listAgents(),
    // Artifacts agents surfaced mid-run (design docs, reports, links). The
    // cockpit groups these by agentId onto the fleet card / drawer.
    flags,
    // The URL to open each local artifact by navigation, carrying its per-flag
    // capability (auth on) or a bare path (auth off). The cockpit opens chips
    // from this map rather than string-building a URL, the same way it looks refs
    // up in refUrls — an http(s) flag is absent here and linked directly.
    artifactUrls: artifactUrls(flags, opts?.artifactSigner),
    // Every file agents wrote (captured by the file-events hook), grouped by
    // agentId in the drawer's "files changed" list; the report-like ones also
    // appear above as artifact chips.
    files,
    // Paths two agents wrote while both were running (issue #113). The three
    // dispatch gates are complete for what they see, and origin/branch are 1:1
    // for every world-driven rule — but none of them can see what an agent does
    // once it is running. This is that blind spot, read off rows we already have
    // rather than off an advisory claim an agent has to remember to make.
    overlaps: detectFileOverlaps({ files, agents: store.listAgents(), tasks }),
    // Things agents noticed outside their own tasks (the `report_finding` tool).
    // Operator-facing only: nothing in the dispatcher reads them, and one becomes
    // work only through `POST /api/findings/:id/promote`.
    findings,
    escalations: store.listEscalations(),
    // Acts a human was asked to authorize (issue #109). The cockpit joins these
    // to their escalation so a decision-bearing item gets accept/reject rather
    // than a text box, and the decision log reads the settled ones as the human
    // half of the audit trail.
    proposals,
    decisions: store.listDecisions(100),
    // The "Up next" queue: the last cycle's ordered pickup plan with the
    // headroom cut (issue #69). A per-pulse projection — null until a cycle
    // has run, or when the active dispatcher doesn't materialise a plan.
    upcoming: harness.upcoming,
    worldEvents: store.listWorldEvents(100),
    // Recorded failures (cycle exceptions, provider outages, agent crashes,
    // route 500s) for the cockpit's Errors panel.
    errors: store.listErrors(100),
    refUrls,
    // The rule book, as data: decision rows carry a rule id; the cockpit looks
    // the id up here to expand a decision into "which rule fired, and why".
    dispatchRules: DISPATCH_RULES,
    usage: buildUsage(system),
  };
}

/**
 * The reviewable half of a stored assay, or null when nobody has judged the goal.
 *
 * Null and `workable` are not the same reading and neither is `unclear`, which is
 * the whole point of the field: a goal nothing has assayed draws no drill at all,
 * while a refused one draws a drill that is stopped and says why. Collapsing the
 * two would put #158's verdict back where it was — legible only as prose inside
 * `pickup.reasons`.
 *
 * `commentRef` is the one thing here the assay says to somebody *else*: the
 * standing comment the desk keeps on the ticket, as a canonical ref (#171). It is
 * the sharper half of that issue — the harness explaining on another person's
 * ticket why it will not act — and until now the operator could only find it by
 * opening the tracker and reading the thread. `goalRef` is still deliberately not
 * shipped: it is a fingerprint the hold is measured against, not a reading.
 */
/**
 * A delivery verdict, shipped **only while it still stands**.
 *
 * The row is not the reading. `deliveryHold` is what rule 4 gates on, and it
 * answers null for a verdict the world has overtaken — the operator moved the
 * ticket back into a pickup state, or a transition landed after `decidedAt`. So
 * the standing-ness is asked here, off the same predicate and the same context
 * `issuePickupStatus` is handed, rather than shipping the row and leaving the
 * cockpit to re-derive an answer from inputs it does not have. A released verdict
 * going null is the point: the issue is back in play and rule 3e will assess it
 * again, so a cockpit still reporting it delivered would be promising a park that
 * has ended.
 *
 * The hold *reason* is deliberately not shipped. It is prose already carried by
 * `pickup.reasons` in every case that surface can report, and a second copy is a
 * second answer to the one question. What this adds is the structural fact —
 * that there is a standing verdict at all — which is exactly what neither
 * `conclusion` nor `pickup.status` can say for a decomposed issue.
 */
function standingDelivery(delivery: IssueDelivery | undefined, issue: Issue, ctx: IssuePickupContext) {
  if (!delivery) return null;
  const held = deliveryHold(delivery, issue, { pickupStates: ctx.policy.pickupStates, signals: ctx.deliverySignals });
  if (!held) return null;
  const { summary, by, decidedAt } = delivery;
  return { summary, by, decidedAt };
}

/**
 * What the Goal Floor's Manifest station needs to draw itself: whether a goal was
 * written up, the one line to show, and when. Deliberately not the document — see
 * the call site.
 */
function retroReading(retro: Retrospective | null) {
  return retro ? { summary: retro.summary, hasDocument: retro.document.length > 0, updatedAt: retro.updatedAt } : null;
}

function assayVerdictOf(assay: IssueAssay | undefined) {
  if (!assay) return null;
  const { verdict, summary, by, decidedAt } = assay;
  return { verdict, summary, by, decidedAt, commentRef: issueCommentRef(assay.originRef, assay.commentRef) };
}

/** A concise task/job title from a free-form prompt: its first non-empty line, capped. */
function deriveTitle(prompt: string): string {
  const firstLine =
    prompt
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'Operator job';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

/**
 * Account-level Claude usage for the cockpit chip (issue #60): the rolling cost
 * windows summed from stream-mode turn reports (all modes, self-computed), plus
 * the real subscriber 5h/weekly limits when the PTY status-line capture has
 * seen any (Pro/Max only — null otherwise, and the UI degrades to cost).
 */
function buildUsage(system: System) {
  const now = Date.now();
  const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
  return {
    windows: {
      fiveHourCostUsd: system.store.sumUsageCostSince(iso(5 * 60 * 60 * 1000)),
      sevenDayCostUsd: system.store.sumUsageCostSince(iso(7 * 24 * 60 * 60 * 1000)),
    },
    rateLimits: system.rateLimits?.readLatest() ?? null,
  };
}
