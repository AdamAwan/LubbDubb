import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import type { System } from '../system.js';
import type { WorldSnapshot } from '../types.js';
import { Hub } from './hub.js';
import { buildRefUrls } from './refUrls.js';
import { prHealth } from '../prHealth.js';
import { prAttentionStatus, type PrAttentionContext } from '../prAttention.js';
import { issuePickupStatus, type IssuePickupContext } from '../dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from '../dispatcher/dispatchCooldown.js';
import type { InjectableEvent } from '../connector/connector.js';
import type { IntegrationSelection } from '../integrations/integration.js';
import { DISPATCH_RULES } from '../dispatcher/rules.js';
import { findingJobRequest, findingTicketFields, trackerCoordinates } from '../mcp/findings.js';
import { isRecoveryVerdict } from '../agents/crashRecovery.js';
import { planProposalRef, rejectionSignalQuery } from '../proposals/proposals.js';
import { detectFileOverlaps } from '../fileOverlap.js';
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
    const next = store.setPlanStatus(id, 'planning');
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
    if (item?.agentId && recovery.isPending(item.agentId))
      return reply.code(409).send({
        error:
          `the agent that asked this crashed — decide its recovery via ` +
          `/api/recovery/${item.agentId} first (restore keeps this question open)`,
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

  // Decide what happens to an agent the previous run left orphaned. **Until every
  // one of these is answered the harness runs no cycles at all**, so this route is
  // the only thing that can un-stick a booted-after-a-crash harness — which is why
  // it settles the verdict inline (like a proposal accept) rather than emitting an
  // action for a pulse that cannot run to pick up.
  //
  // A refusal is a 409 with the reason, and leaves the item pending: a restore the
  // runtime declines is not a decision, and the operator still has requeue and
  // remove. The cycle is kicked only once the *last* decision lands, since one
  // kicked while others are outstanding would just return the hold.
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
    refs: [...findings.map((f) => f.ref), ...findings.map((f) => f.ticketRef), ...proposals.map((p) => p.ref)],
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
      })),
      issues: world.issues.map((issue) => ({ ...issue, pickup: issuePickupStatus(issue, pickupCtx) })),
    },
    // The plan graph, which until now existed only in the database: the per-issue
    // chip could say "2/5 parts merged" and nothing could say *which* five. The
    // cockpit joins parts to `upcoming` by origin to draw the dispatch cut.
    plans,
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
