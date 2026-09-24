import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

// → docs/spec/16-http-api.md#request-validation

interface Refused {
  ok: false;
  error: string;
}

type RequestRead<P, B, Q> = { ok: true; params: P; body: B; query: Q } | Refused;

export function readRequest<P = undefined, B = undefined, Q = undefined>(
  req: { params?: unknown; body?: unknown; query?: unknown },
  schemas: {
    params?: z.ZodType<P, z.ZodTypeDef, unknown>;
    body?: z.ZodType<B, z.ZodTypeDef, unknown>;
    query?: z.ZodType<Q, z.ZodTypeDef, unknown>;
  },
): RequestRead<P, B, Q> {
  const params = readPart(schemas.params, req.params);
  if (!params.ok) return params;
  const query = readPart(schemas.query, req.query);
  if (!query.ok) return query;
  const body = readPart(schemas.body, req.body);
  if (!body.ok) return body;
  return { ok: true, params: params.data as P, body: body.data as B, query: query.data as Q };
}

function readPart<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | undefined,
  raw: unknown,
): { ok: true; data: T | undefined } | Refused {
  const parsed = schema?.safeParse(raw ?? {});
  if (parsed && !parsed.success) return { ok: false, error: refusalMessage(parsed.error) };
  return { ok: true, data: parsed?.data };
}

export function checked<P = undefined, B = undefined, Q = undefined>(
  schemas: {
    params?: z.ZodType<P, z.ZodTypeDef, unknown>;
    body?: z.ZodType<B, z.ZodTypeDef, unknown>;
    query?: z.ZodType<Q, z.ZodTypeDef, unknown>;
  },
  handler: (input: { params: P; body: B; query: Q; req: FastifyRequest; reply: FastifyReply }) => unknown,
): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (req, reply) => {
    const input = readRequest(req, schemas);
    if (!input.ok) return reply.code(400).send({ error: input.error });
    return handler({ params: input.params, body: input.body, query: input.query, req, reply });
  };
}

function refusalMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

function integerParam(label: string): z.ZodType<number, z.ZodTypeDef, string> {
  return z
    .string()
    .refine((raw) => Number.isInteger(Number(raw)), { message: `invalid ${label}` })
    .transform(Number);
}

export const IssueNumberParams = z.object({ number: integerParam('issue number') });

export const PrNumberParams = z.object({ number: integerParam('PR number') });

export const IdParams = z.object({ id: z.string() });

export const RefParams = z.object({ ref: z.string() });

export function requiredBoolean(message: string): z.ZodBoolean {
  return z.boolean({ required_error: message, invalid_type_error: message });
}

export function requiredText(message: string, max?: { length: number; message: string }): z.ZodType<string> {
  const base = z.string({ required_error: message, invalid_type_error: message }).trim().min(1, message);
  return max ? base.max(max.length, max.message) : base;
}

export function optionalText(field: string): z.ZodType<string | undefined> {
  return z
    .string({ invalid_type_error: `${field} must be a string` })
    .trim()
    .optional()
    .transform((text) => text || undefined);
}

export const TicketTitleBody = z.object({ title: optionalText('title') });

export const AcceptanceBody = z.object({
  slug: requiredText('slug is required — the part the criterion belongs to'),
  criterion: requiredText('criterion is required — the text of the criterion being ticked'),
  met: requiredBoolean('met must be true or false'),
});
