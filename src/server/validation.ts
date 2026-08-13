import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * Reading a request's params and body as *checked* values rather than asserted
 * ones (issue #223).
 *
 * `req.params as { number: string }` is a claim about data the server does not
 * control, and every field the handler reads after it is typed as though
 * something validated it. What actually held were the hand-written checks that
 * followed — written fresh per route, so what a route validated was whatever its
 * author remembered and nothing made the next one consistent with either. The
 * dispatcher's actions (`dispatcher/actions.ts`), the plan document and every
 * MCP tool argument already go through zod with the rejection returned to the
 * caller synchronously; this is that same discipline on the surface `auth.ts`
 * describes as "an RCE endpoint with repo write and a billing side-effect".
 *
 * Three things carry it:
 *
 * - **A refusal is a value, not a throw.** `app.setErrorHandler` means "an
 *   unanticipated throw" and records every one to the error log (which mirrors to
 *   stderr and streams to the cockpit's Errors panel). A malformed request is
 *   neither unanticipated nor the harness's fault, so routing it there would bury
 *   real faults under other people's typos.
 * - **Every field states its own refusal in full** ("cap must be a number"),
 *   because {@link refusalMessage} joins issue messages and drops their field
 *   paths. A field declared without a message refuses with zod's stock text,
 *   which names nothing — so declaring one is the convention, not a nicety.
 * - **Params and body are read separately where the route needs them to be.**
 *   Several routes answer 404/409 off the store between the two (a finding that
 *   does not exist is not a bad request), so this reads whichever schemas it is
 *   given and the handler decides the order.
 *
 * {@link checked} is how a route says all of that in one word: it wraps the
 * handler, so a handler is *handed* checked values and never sees the raw
 * request. That is what removes the 36 verbatim copies of the 400 line that
 * `buildApp` used to carry, and with them the way to forget one.
 */

/** A request refused before the handler acted, carrying the 400 body's `error`. */
interface Refused {
  ok: false;
  error: string;
}

/** What {@link readRequest} hands back: the parsed values, or the one refusal string. */
type RequestRead<P, B> = { ok: true; params: P; body: B } | Refused;

/**
 * Parse whichever of `params`/`body` a route declares. Params are read first, so
 * a request that names no such item is refused for that rather than for whatever
 * else its body got wrong.
 *
 * A missing body is parsed as `{}` — Fastify leaves `req.body` undefined for a
 * request that sent none, and every schema here is an object, so this is what
 * lets an all-optional body be omitted entirely while a required field still
 * refuses by name.
 */
export function readRequest<P = undefined, B = undefined>(
  req: { params?: unknown; body?: unknown },
  // `unknown` as the schemas' *input* type is what lets a schema transform on the
  // way through — a `:number` param arrives as a string and leaves as a number, a
  // `kind` defaults, a note is trimmed — while `P`/`B` still infer from what the
  // handler receives.
  schemas: { params?: z.ZodType<P, z.ZodTypeDef, unknown>; body?: z.ZodType<B, z.ZodTypeDef, unknown> },
): RequestRead<P, B> {
  const params = schemas.params?.safeParse(req.params ?? {});
  if (params && !params.success) return { ok: false, error: refusalMessage(params.error) };
  const body = schemas.body?.safeParse(req.body ?? {});
  if (body && !body.success) return { ok: false, error: refusalMessage(body.error) };
  // The two casts are the only ones left, and they are sound: a schema that was
  // given produced `data` of its own output type, and one that was not leaves
  // `undefined`, which is what the generic defaults to for a route that declares
  // no such half.
  return { ok: true, params: params?.data as P, body: body?.data as B };
}

/**
 * A route handler that receives *checked* input, wrapped into one Fastify
 * handler. The single place on this surface that turns a refusal into a `400`.
 *
 * The 36 hand-written copies of `if (!input.ok) return reply.code(400)...` this
 * replaces were the weak half of issue #223: every one of them was correct, and
 * nothing but a source grep said the 37th had to be. A handler that is *handed*
 * `params` and `body` has no raw request to assert about and no check to skip —
 * the property is held by the signature rather than by a test reading the file.
 *
 * `req` and `reply` ride in the same record rather than as trailing positional
 * arguments so a handler destructures exactly what it uses; most want `reply`
 * for a 404/409 and nothing else.
 *
 * The wrapper is also **callable by hand**, which is what the three routes that
 * answer 404/409 off the store between the params and the body do:
 * `return checked({ body: X }, handler)(req, reply)` inside an outer
 * `checked({ params: Y }, ...)`. Same one refusal path, in the order the route
 * needs.
 */
export function checked<P = undefined, B = undefined>(
  schemas: { params?: z.ZodType<P, z.ZodTypeDef, unknown>; body?: z.ZodType<B, z.ZodTypeDef, unknown> },
  handler: (input: { params: P; body: B; req: FastifyRequest; reply: FastifyReply }) => unknown,
): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (req, reply) => {
    const input = readRequest(req, schemas);
    if (!input.ok) return reply.code(400).send({ error: input.error });
    return handler({ params: input.params, body: input.body, req, reply });
  };
}

/**
 * The 400 body's `error`. Messages only, joined — see the note above on why each
 * schema states its refusal in full rather than relying on the field path.
 */
function refusalMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

/**
 * A path parameter naming an integer. `Number` rather than `parseInt`, and the
 * integer check rather than a regex, because that is exactly what the seven
 * hand-written copies did — this must not quietly start refusing (or accepting)
 * a path the old check let through.
 */
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

/** `:id` — an opaque store key (agent, job, finding, plan, escalation, proposal, task, flag). */
export const IdParams = z.object({ id: z.string() });

/** `:ref` — a work-graph, retrospective or scratchpad ref, checked for meaning by its route. */
export const RefParams = z.object({ ref: z.string() });

/**
 * A boolean a route requires, refusing absence and a wrong type in the same
 * words — the distinction is one no caller of these routes can act on
 * differently, and saying it twice per field is how the wordings drift apart.
 */
export function requiredBoolean(message: string): z.ZodBoolean {
  return z.boolean({ required_error: message, invalid_type_error: message });
}

/**
 * Optional free text — a note, a summary, an operator's reworded title. Trimmed,
 * with blank read as absent, because every route taking one already treated `''`
 * and "not given" as the same thing and fell back to its own default.
 *
 * One deliberate tightening: a *non-string* value here is now a 400 naming the
 * field, where several routes used to test `typeof x === 'string'` inline and
 * silently fall back to the default. Silently ignoring a field the caller
 * clearly meant to set is the failure this whole change is about.
 */
export function optionalText(field: string): z.ZodType<string | undefined> {
  return z
    .string({ invalid_type_error: `${field} must be a string` })
    .trim()
    .optional()
    .transform((text) => text || undefined);
}

/**
 * The operator's override of a derived ticket title, shared by the two routes
 * that file one — `/api/findings/:id/file` and `/api/work/:ref/file`. Here
 * rather than in either of them because both offer the same override over their
 * own derived default, and a second copy is how the two come to word it
 * differently.
 */
export const TicketTitleBody = z.object({ title: optionalText('title') });

/**
 * One acceptance criterion of one plan part, ticked or un-ticked.
 *
 * The criterion is identified by its **text**, which is how the confirmation is
 * stored — an index would move under a re-worded list and carry a tick onto a
 * criterion nobody looked at. Refusing a text no criterion carries is the route's
 * job, not the schema's: it is a fact about the part, and this is a request shape.
 */
export const AcceptanceBody = z.object({
  slug: z.string().min(1, 'slug is required'),
  criterion: z.string().min(1, 'criterion is required'),
  met: requiredBoolean('met must be true or false'),
});
