# CLAUDE.md — `src/server/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Startup

- **Anything in `main.ts` that can start an agent goes _below_ the signal handlers.** A Ctrl-C
  above them takes Node's default path, which runs no handler: agents launched, not reaped, not
  recorded. → [21](../../docs/spec/21-self-update.md#where-the-shutdown-handlers-are-registered)

## Routes

- **A route refusal is a returned value and a 400, not a throw** — `setErrorHandler` means _unanticipated_. Handlers
  take `checked` input (asserted). → [16](../../docs/spec/16-http-api.md#request-validation)
- **A new route goes in the `src/server/routes/` module that owns its group**; a new group is a new
  module plus an entry in `app.ts`'s `ROUTE_MODULES`. A schema encoding a domain rule lives with the
  rule — `ShortfallBody` is in `src/delivery/shortfall.ts`. → [16](../../docs/spec/16-http-api.md#shape)
