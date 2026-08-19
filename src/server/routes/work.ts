import type { FastifyInstance } from 'fastify';
import type { WorkRootsPayload, WorkSubtreePayload } from '../../wire.js';
import { trackerCoordinates } from '../../mcp/findings.js';
import { unrecordedWork, workItemTicketFields } from '../../graph/unrecorded.js';
import { checked, RefParams, TicketTitleBody } from '../validation.js';
import type { RouteContext } from './context.js';

/** The work graph the cockpit's panel draws, and the two verdicts an operator casts on a node. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, errors } = system;

  // Deliberately *not* folded into `/api/state`: that endpoint is polled
  // continuously, so shipping the whole forest on every poll is the wrong shape.
  // Roots are cheap; a subtree is fetched when a panel is opened. Both sit under
  // the `/api` prefix, so the auth hook `buildApp` registers covers them with no
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
  app.get('/api/work', WORK_RATE_LIMIT, async () => {
    const roots = store.listWorkRoots();
    const unrecorded = unrecordedWork(
      store.listWorkNodes(),
      store.listJobs(),
      store.listWorkItemFilings(),
      store.listWorkItemIgnores(),
    );
    // The panel draws each root and unrecorded item by its ref, so it needs a URL
    // for each — resolved off the connector here (not the snapshot's `refUrls`,
    // which this route doesn't ship) exactly as the subtree route does, because a
    // PR the graph remembers merging left the world hours ago. Unresolvable refs
    // are simply absent and the cockpit renders them as plain text.
    const refUrls: Record<string, string> = {};
    for (const ref of [...roots.map((r) => r.ref), ...unrecorded.map((u) => u.ref)]) {
      const url = connector.resolveRefUrl(ref);
      if (url) refUrls[ref] = url;
    }
    return { roots, unrecorded, refUrls } satisfies WorkRootsPayload;
  });

  // The other verdict on the same row: no tracker item is wanted for this work.
  // A delete undoes it, so the panel can offer it back — an ignore that could only
  // be set would make an accidental click permanent, which is the wrong shape for
  // a lens whose whole content is the harness's own guess about what matters.
  app.post(
    '/api/work/:ref/ignore',
    WORK_RATE_LIMIT,
    checked({ params: RefParams }, async ({ params, reply }) => {
      const { ref } = params;
      if (!store.listWorkNodes().some((n) => n.ref === ref))
        return reply.code(404).send({ error: 'no such work item' });
      store.ignoreWorkItem(ref);
      return { ok: true };
    }),
  );

  app.delete(
    '/api/work/:ref/ignore',
    WORK_RATE_LIMIT,
    checked({ params: RefParams }, async ({ params }) => {
      store.unignoreWorkItem(params.ref);
      return { ok: true };
    }),
  );

  // File a work item for work the harness did that nothing external accounts for
  // — an operator job that produced commits with no issue anywhere behind it. The
  // mirror of `/api/findings/:id/file`, and an **operator click** for that route's
  // reason: creating tracker items on the harness's own initiative would be a new
  // outbound capability on the world, and the condition it fires on is permanent
  // until acted on, so a throttle would only set the rate at which a backlog
  // fills. See src/graph/unrecorded.ts for the full argument.
  app.post(
    '/api/work/:ref/file',
    WORK_RATE_LIMIT,
    checked({ params: RefParams }, async ({ params, req, reply }) => {
      const { ref } = params;
      const node = store.listWorkNodes().find((n) => n.ref === ref);
      if (!node) return reply.code(404).send({ error: 'no such work item' });

      const filings = store.listWorkItemFilings();
      const standing = filings.find((f) => f.targetRef === ref);
      if (standing)
        return reply.code(409).send({
          error:
            standing.status === 'filing'
              ? 'a work item for this is already being filed'
              : `already filed as ${standing.ticketRef}`,
        });
      // Asked of the same predicate the panel draws from, so the route can never
      // refuse what the button offered — including the ignore, which the predicate
      // carries rather than filters precisely so both surfaces read one verdict.
      const [entry] = unrecordedWork([node], store.listJobs(), filings, store.listWorkItemIgnores());
      if (!entry) return reply.code(409).send({ error: `${ref} is not unrecorded work — it has a work item already` });
      if (entry.ignored) return reply.code(409).send({ error: `${ref} is ignored — un-ignore it before filing` });

      // With no tracker configured there is nowhere to file. The cockpit hides the
      // button in this case, so reaching here means a direct call. The same gate all
      // four filing arms ask, so all four refuse identically.
      if (trackerCoordinates(system.config) === null)
        return reply
          .code(409)
          .send({ error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)' });

      // The body last, after every 404/409 the store answers — `/api/findings/:id/file`'s
      // order, and `checked` applied by hand is what keeps the refusal path one.
      return checked({ body: TicketTitleBody }, async ({ body }) => {
        const derived = workItemTicketFields(node, store.listWorkSubtree(ref));
        const title = body.title ?? derived.title;
        // Rendered from the operator's template book, not built here: how a work item
        // should read is exactly the sort of house style an override exists for. It is
        // the item's **body**, not a prompt — nothing is dispatched for this (issue
        // #394). The whole text was already composed by the harness; all a desk agent
        // added was a title, which the node already has.
        const itemBody = system.prompts.render('work-item-ticket-body', derived.vars);
        // The claim first, and it is what makes a double-click safe: `target_ref` is
        // the primary key, so the second one loses here rather than after a second
        // ticket exists.
        const filing = store.createWorkItemFiling({ targetRef: ref });
        if (!filing) return reply.code(409).send({ error: 'a work item for this is already being filed' });
        let ticketRef: string;
        try {
          ticketRef = await system.filing({ title, body: itemBody });
        } catch (err) {
          // The claim goes back, so the button returns rather than the node sitting
          // on a filing that will never complete.
          store.dropWorkItemFiling(ref);
          errors.record({
            source: 'provider',
            message: `filing a work item for ${ref} failed: ${(err as Error).message}`,
          });
          return reply.code(502).send({ error: `the tracker refused the item: ${(err as Error).message}` });
        }
        const filed = store.linkWorkItemFiling(ref, ticketRef);
        hub.broadcast({ type: 'world:changed' });
        const report = await harness.runCycle('manual');
        return { ok: true, filing: filed ?? filing, report };
      })(req, reply);
    }),
  );

  app.get(
    '/api/work/:ref',
    WORK_RATE_LIMIT,
    checked({ params: RefParams }, async ({ params, reply }) => {
      const nodes = store.listWorkSubtree(params.ref);
      if (nodes.length === 0) return reply.code(404).send({ error: 'no such work item' });
      // Resolved here rather than read off the snapshot's `refUrls`: that map is
      // built from the world, and a PR the graph remembers merging left the world
      // hours ago — the connector can still name its URL.
      const refUrls: Record<string, string> = {};
      // A node's own ref, and the `base_ref` it stacks on — the row draws both, so
      // both get a URL (deduped; a base is another node's ref most of the time).
      for (const ref of nodes.flatMap((node) => [node.ref, node.baseRef])) {
        if (!ref || ref in refUrls) continue;
        const url = connector.resolveRefUrl(ref);
        if (url) refUrls[ref] = url;
      }
      return { nodes, refUrls } satisfies WorkSubtreePayload;
    }),
  );

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
}
