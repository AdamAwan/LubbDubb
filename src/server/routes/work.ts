import type { FastifyInstance } from 'fastify';
import type { WorkRootsPayload, WorkSubtreePayload } from '../../wire.js';
import { trackerCoordinates } from '../../mcp/findings.js';
import { unrecordedWork, workItemTicketFields } from '../../graph/unrecorded.js';
import { checked, RefParams, TicketTitleBody } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, errors } = system;

  const WORK_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get('/api/work', WORK_RATE_LIMIT, async () => {
    const roots = store.listWorkRoots();
    const unrecorded = unrecordedWork(
      store.listWorkNodes(),
      store.listJobs(),
      store.listWorkItemFilings(),
      store.listWorkItemIgnores(),
    );
    const refUrls: Record<string, string> = {};
    for (const ref of [...roots.map((r) => r.ref), ...unrecorded.map((u) => u.ref)]) {
      const url = connector.resolveRefUrl(ref);
      if (url) refUrls[ref] = url;
    }
    return { roots, unrecorded, refUrls } satisfies WorkRootsPayload;
  });

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
      const [entry] = unrecordedWork([node], store.listJobs(), filings, store.listWorkItemIgnores());
      if (!entry) return reply.code(409).send({ error: `${ref} is not unrecorded work — it has a work item already` });
      if (entry.ignored) return reply.code(409).send({ error: `${ref} is ignored — un-ignore it before filing` });

      if (trackerCoordinates(system.config) === null)
        return reply
          .code(409)
          .send({ error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)' });

      return checked({ body: TicketTitleBody }, async ({ body }) => {
        const derived = workItemTicketFields(node, store.listWorkSubtree(ref));
        const title = body.title ?? derived.title;
        const itemBody = system.prompts.render('work-item-ticket-body', derived.vars);
        const filing = store.createWorkItemFiling({ targetRef: ref });
        if (!filing) return reply.code(409).send({ error: 'a work item for this is already being filed' });
        let ticketRef: string;
        try {
          ticketRef = await system.filing({ title, body: itemBody });
        } catch (err) {
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
      const refUrls: Record<string, string> = {};
      for (const ref of nodes.flatMap((node) => [node.ref, node.baseRef])) {
        if (!ref || ref in refUrls) continue;
        const url = connector.resolveRefUrl(ref);
        if (url) refUrls[ref] = url;
      }
      return { nodes, refUrls } satisfies WorkSubtreePayload;
    }),
  );
}
