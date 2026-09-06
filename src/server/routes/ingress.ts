import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { checked } from '../validation.js';
import type { IngressProvider } from '../../ingress/ingress.js';
import type { RouteContext } from './context.js';
import type { FastifyInstance } from 'fastify';

// → docs/spec/16-http-api.md

const rawBodies = new WeakMap<IncomingMessage, Buffer>();

const DeliveryBody = z
  .object(
    {},
    {
      invalid_type_error: 'a delivery body must be a JSON object',
      required_error: 'a delivery body must be a JSON object',
    },
  )
  .passthrough();

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function register(root: FastifyInstance, ctx: RouteContext): void {
  const { ingress, config } = ctx.system;

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
      return { accepted: verdict.refs.length };
    });

  root.register(async (app) => {
    // TECHDEBT: kept as bytes and parsed here rather than by Fastify's built-in parser,
    // because `JSON.stringify(JSON.parse(x))` is not `x` — key order, floats and any
    // non-ASCII text all move — so a signature checked against a re-serialised body
    // fails on exactly the deliveries carrying an emoji in a comment.
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, payload, done) => {
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      rawBodies.set(req.raw, bytes);
      try {
        done(null, JSON.parse(bytes.toString('utf8')));
      } catch (err) {
        done(Object.assign(err instanceof Error ? err : new Error('invalid JSON'), { statusCode: 400 }), undefined);
      }
    });

    app.post('/ingress/github', bounds('github'), deliver('github'));
    app.post('/ingress/azure', bounds('azure'), deliver('azure'));
  });
}
