import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { checked } from '../validation.js';
import type { IngressProvider } from '../../ingress/ingress.js';
import type { RouteContext } from './context.js';
import type { FastifyInstance } from 'fastify';

/**
 * The inbound webhook surface: `POST /ingress/github` and `POST /ingress/azure`.
 *
 * **The only unauthenticated, internet-facing route in the product.** Everything
 * about the shape of this module follows from that, and each piece is stated where
 * it is done rather than in a comment at the top:
 *
 * - It sits **outside `/api`**, because the cockpit's bearer guard matches that
 *   prefix (`src/server/auth.ts`) and no provider can present a cockpit token. It
 *   is the same reason `/artifacts/:id` and `/attachments/:id` are outside it, and
 *   it carries the same obligation: the route authorizes itself, and refuses a
 *   request that carries nothing. `test/cockpitAuth.test.ts` holds that over the
 *   whole route table so this cannot quietly become reachable.
 * - The signature covers the **raw bytes**, which the parsed-body seam does not
 *   hand over — so this module installs its own content-type parser, inside an
 *   encapsulated plugin so it applies to nothing else. The parser keeps the bytes
 *   in a `WeakMap` keyed by the underlying request; the handler is still *handed*
 *   its checked body and asserts nothing about the request.
 * - Every bound this endpoint has is a route option: a body limit, a rate limit
 *   keyed to the endpoint rather than to the caller, and — beyond HTTP — the
 *   floor on how often a delivery may cause a cycle, which lives on the trigger.
 *
 * → `docs/spec/30-ingress.md`, `docs/spec/16-http-api.md#the-ingress-endpoint`
 */

/**
 * The raw bytes of the request being handled, keyed by the Node request object.
 *
 * A `WeakMap` rather than a property bolted onto `FastifyRequest`: the handler
 * reads it through the same object Fastify gave it, so nothing is asserted about a
 * request's shape and nothing outlives the request. Module-private, so the only
 * things that can put bytes in it are the parser below.
 */
const rawBodies = new WeakMap<IncomingMessage, Buffer>();

/**
 * A delivery body: a JSON **object**, and nothing more is claimed here.
 *
 * The meaning is read in `src/ingress/delivery.ts`, per event and per provider,
 * because that is where the knowledge of which field names an entity lives. What
 * this schema is for is the one refusal the route itself can state: a body that is
 * not an object names nothing at all.
 */
const DeliveryBody = z
  .object(
    {},
    {
      invalid_type_error: 'a delivery body must be a JSON object',
      required_error: 'a delivery body must be a JSON object',
    },
  )
  .passthrough();

/** The header value, when the client sent exactly one of it. */
function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function register(root: FastifyInstance, ctx: RouteContext): void {
  const { ingress, config } = ctx.system;

  // The bounds an unauthenticated caller meets before any work is done. The rate
  // limit is keyed to the **endpoint**, not to `req.ip`: a webhook arrives from a
  // provider's whole address range, and per-caller keying on a public port is a
  // budget an attacker multiplies by changing address. What that trades away is
  // that one noisy source can spend the budget a real delivery needed — survivable
  // precisely because polling is still the backstop.
  const bounds = (provider: IngressProvider) => ({
    bodyLimit: config.ingress.maxBodyBytes,
    config: {
      rateLimit: {
        max: config.ingress.requestsPerMinute,
        timeWindow: '1 minute',
        keyGenerator: () => `ingress:${provider}`,
      },
    },
  });

  /** One provider's handler. Two routes, one body — the providers differ only in how they authenticate. */
  const deliver = (provider: IngressProvider) =>
    checked({ body: DeliveryBody }, async ({ body, req, reply }) => {
      const verdict = ingress.handle(provider, {
        raw: rawBodies.get(req.raw) ?? Buffer.alloc(0),
        body,
        signature: header(req.headers, 'x-hub-signature-256'),
        authorization: header(req.headers, 'authorization'),
        event: header(req.headers, 'x-github-event'),
        deliveryId: header(req.headers, 'x-github-delivery'),
      });
      if (!verdict.ok) return reply.code(verdict.status).send({ error: verdict.error });
      // The count and nothing else. A provider retries on a non-2xx, so this body is
      // only ever read by an operator with curl — and it must not confirm to an
      // unauthenticated caller which entities this fleet is watching.
      return { accepted: verdict.refs.length };
    });

  // Encapsulated, so the content-type parser below is this plugin's and the JSON
  // every other route receives is still Fastify's own. `app` shadows the root
  // instance deliberately: the two structural sweeps that walk this directory —
  // `test/cockpitAuth.test.ts` for the guard, `test/requestValidation.test.ts` for
  // the refusal wording — find routes by matching the instance name against a
  // literal path, and a route they cannot see is a route neither of them holds.
  root.register(async (app) => {
    // Kept as bytes and parsed here rather than by Fastify's built-in parser,
    // because `JSON.stringify(JSON.parse(x))` is not `x` — key order, floats and any
    // non-ASCII text all move — so a signature checked against a re-serialised body
    // fails on exactly the deliveries carrying an emoji in a comment.
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, payload, done) => {
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      rawBodies.set(req.raw, bytes);
      try {
        done(null, JSON.parse(bytes.toString('utf8')));
      } catch (err) {
        // Refused by the framework as a 400 that is the caller's own fault, exactly
        // as a malformed body is on every other route: `buildApp`'s error handler
        // returns a 4xx that classified itself and records nothing, so a stranger
        // posting junk at this port cannot fill the operator's Errors panel.
        done(Object.assign(err instanceof Error ? err : new Error('invalid JSON'), { statusCode: 400 }), undefined);
      }
    });

    app.post('/ingress/github', bounds('github'), deliver('github'));
    app.post('/ingress/azure', bounds('azure'), deliver('azure'));
  });
}
