import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * Reading a request's params, query and body as *checked* values rather than asserted ones.
 * → `docs/spec/16-http-api.md#request-validation`
 */

/** A request refused before the handler acted, carrying the 400 body's `error`. */
interface Refused {
  ok: false;
  error: string;
}

/** What {@link readRequest} hands back: the parsed values, or the one refusal string. */
type RequestRead<P, B, Q> = { ok: true; params: P; body: B; query: Q } | Refused;

/** Parse whichever of `params`/`query`/`body` a route declares. */
export function readRequest<P = undefined, B = undefined, Q = undefined>(
  req: { params?: unknown; body?: unknown; query?: unknown },
  // `unknown` as the schemas' *input* type lets a schema transform on the way
  // through (a `:number` param arrives as a string) while `P`/`B` still infer.
  schemas: {
    params?: z.ZodType<P, z.ZodTypeDef, unknown>;
    body?: z.ZodType<B, z.ZodTypeDef, unknown>;
    query?: z.ZodType<Q, z.ZodTypeDef, unknown>;
  },
): RequestRead<P, B, Q> {
  const params = schemas.params?.safeParse(req.params ?? {});
  if (params && !params.success) return { ok: false, error: refusalMessage(params.error) };
  // Read in the order a reader would blame them: a request that names no such item
  // is refused for that before whatever its query or body got wrong.
  const query = schemas.query?.safeParse(req.query ?? {});
  if (query && !query.success) return { ok: false, error: refusalMessage(query.error) };
  const body = schemas.body?.safeParse(req.body ?? {});
  if (body && !body.success) return { ok: false, error: refusalMessage(body.error) };
  // Sound: a schema that was given produced `data` of its own output type; one
  // that was not leaves `undefined`, the generic's default for that half.
  return { ok: true, params: params?.data as P, body: body?.data as B, query: query?.data as Q };
}

/** A route handler that receives *checked* input, wrapped into one Fastify handler. */
export function checked<P = undefined, B = undefined, Q = undefined>(
  schemas: {
    params?: z.ZodType<P, z.ZodTypeDef, unknown>;
    body?: z.ZodType<B, z.ZodTypeDef, unknown>;
    /** The query string, declared the same way as the other two. */
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

/** The 400 body's `error`: issue messages only, joined — field paths are dropped. */
function refusalMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

/** A path parameter naming an integer. */
function integerParam(label: string): z.ZodType<number, z.ZodTypeDef, string> {
  return z
    .string()
    .refine((raw) => Number.isInteger(Number(raw)), { message: `invalid ${label}` })
    .transform(Number);
}

/** `/api/issues/:number/...` — the shape six routes repeated by hand. */
export const IssueNumberParams = z.object({ number: integerParam('issue number') });

/** `/api/prs/:number/...`, which words the same refusal for the other kind of number. */
export const PrNumberParams = z.object({ number: integerParam('PR number') });

/**
 * `:id` — an opaque store key (agent, job, finding, plan, escalation, proposal, task,
 * flag).
 */
export const IdParams = z.object({ id: z.string() });

/** `:ref` — a work-graph, retrospective or scratchpad ref, checked for meaning by its route. */
export const RefParams = z.object({ ref: z.string() });

/** A boolean a route requires, wording absence and a wrong type alike. */
export function requiredBoolean(message: string): z.ZodBoolean {
  return z.boolean({ required_error: message, invalid_type_error: message });
}

/**
 * A string a route requires, wording absence, a wrong type and a blank value in the same
 * sentence.
 */
export function requiredText(message: string, max?: { length: number; message: string }): z.ZodType<string> {
  const base = z.string({ required_error: message, invalid_type_error: message }).trim().min(1, message);
  return max ? base.max(max.length, max.message) : base;
}

/**
 * Optional free text — a note, a summary, an operator's reworded title. Trimmed, with blank
 * read as absent; a non-string is a 400 naming the field rather than a silent fall back to
 * the route's default.
 */
export function optionalText(field: string): z.ZodType<string | undefined> {
  return z
    .string({ invalid_type_error: `${field} must be a string` })
    .trim()
    .optional()
    .transform((text) => text || undefined);
}

/**
 * The operator's override of a derived ticket title, shared by the two routes that file one
 * — `/api/findings/:id/file` and `/api/work/:ref/file`.
 */
export const TicketTitleBody = z.object({ title: optionalText('title') });

/** One acceptance criterion of one plan part, ticked or un-ticked. */
export const AcceptanceBody = z.object({
  slug: requiredText('slug is required — the part the criterion belongs to'),
  criterion: requiredText('criterion is required — the text of the criterion being ticked'),
  met: requiredBoolean('met must be true or false'),
});
