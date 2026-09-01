# 30 — Event-driven ingress

Polling costs little since the world read became change-gated and lane-split
([04](04-harness-cycle.md#hot-and-cold), [15](15-integrations.md)), but it is still a clock, and a
clock is latency by construction: on the default cadence the harness learns about a review comment or
a finished build up to thirty seconds after it happened, and up to five minutes on an idle fleet.

An inbound **webhook** (GitHub) or **service hook** (Azure DevOps) is the only way to hear about it as
it happens, and it costs no polling at all. This document owns that endpoint: what it accepts, what
its verification actually proves, what one delivery invalidates, what pulse it causes, and what it
deliberately does not trust.

## The one rule everything else follows from

**A delivery is a request to look again. It is never a fact about the world.**

Nothing a payload says is written anywhere, believed about any entity, or shown to an operator. The
only thing taken out of a delivery is a number naming an entity, and the only thing done with that
number is to drop one cached hydration so the next pulse re-reads that entity **through the
authenticated provider API**, exactly as it would have anyway. Everything the harness believes still
comes from a read it made itself with its own credentials.

That is what makes an unauthenticated, internet-facing endpoint tolerable in a product whose cockpit
is otherwise described as "an RCE endpoint with repo write and a billing side-effect"
(`src/server/auth.ts`). The worst a forged, replayed or malformed delivery can achieve is to make this
fleet re-read an entity it was going to re-read anyway, slightly sooner.

**The slow lane stays.** A webhook is not a delivery guarantee: deliveries are dropped, endpoints go
down, secrets rotate, and a fleet behind a firewall receives none at all. Polling remains the
backstop, correctness never depends on a delivery arriving, and a deployment with no ingress
configured behaves exactly as it did before this existed.

## The endpoint

| Route                  | Provider     | Verified by                                   |
| ---------------------- | ------------ | --------------------------------------------- |
| `POST /ingress/github` | GitHub       | `X-Hub-Signature-256` (HMAC-SHA256, raw body) |
| `POST /ingress/azure`  | Azure DevOps | `Authorization: Basic …`                      |

Both live in `src/server/routes/ingress.ts` and take `application/json` only. Both answer:

| Status | Meaning                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| `200`  | Accepted. Body is `{"accepted": <count of refs invalidated>}` and nothing else.        |
| `400`  | The body was not JSON, or not a JSON object.                                           |
| `401`  | No valid credential.                                                                   |
| `404`  | This deployment has no secret for that provider — see [turning it on](#turning-it-on). |
| `413`  | The body was larger than `ingress.maxBodyBytes`.                                       |
| `429`  | More than `ingress.requestsPerMinute` deliveries this minute.                          |

A `200` says only how many entities were marked. It never names them: an unauthenticated caller must
not be able to learn which pull requests this fleet is watching by watching the reply change.

### Why it is outside `/api`

The cockpit's bearer guard matches the `/api` prefix and `/ws`
([16](16-http-api.md#authentication)), and no webhook provider can present a cockpit token. So the
ingress routes sit outside that prefix — the same reason `/artifacts/:id` and `/attachments/:id` do —
and carry the same obligation: **each authorizes itself, and refuses a request that carries nothing.**
`test/cockpitAuth.test.ts` walks the whole route table and asserts that every route outside `/api`
refuses a bare request, so neither of these can quietly become reachable.

### Why it has its own body parser

The signature covers the **raw bytes**, and the parsed-body seam does not hand those over.
`JSON.stringify(JSON.parse(x))` is not `x` for any payload with non-ASCII text, a float, or key order
the provider chose — so a signature checked against a re-serialised body fails on exactly the
deliveries that carry an emoji in a comment, which is a failure that looks like a wrong secret.

So the module registers its own `application/json` content-type parser inside an **encapsulated
Fastify plugin**, which keeps it off every other route, and stashes the bytes in a module-private
`WeakMap` keyed by the underlying request object. The handler is still wrapped in `checked` and still
_handed_ its validated body — it asserts nothing about the request and reads no raw request itself, so
the structural sweep in `test/requestValidation.test.ts` holds over this module unchanged
([16](16-http-api.md#request-validation)).

## What verification guarantees

Stated honestly per provider, because the two are not close to equivalent.
Both comparisons are constant-time (`src/ingress/signature.ts`).

### GitHub

HMAC-SHA256 of the raw request body under a shared secret, hex-encoded behind `sha256=`.

**It proves** the bytes were produced by somebody holding the secret and arrived unmodified.

**It does not prove freshness.** Nothing in the signed material is a timestamp or a nonce, so a
delivery captured off the wire — or replayed out of GitHub's own redelivery UI — verifies again,
forever. See [replay](#replay).

### Azure DevOps

Azure service hooks do not sign their payloads. What a subscription can be given is HTTP **basic**
credentials, which Azure then sends on every POST.

**It proves** the caller knows a shared username and password.

**It does not authenticate the body at all.** Nothing in the request is bound to its contents, so
anyone holding the credential can post any payload. And it is a bearer credential replayed verbatim on
every delivery, so it is worth exactly what the transport is worth: over plain HTTP it is base64 on the
wire, recoverable by anyone on any hop between Azure and the endpoint. **The operator must terminate
TLS in front of this endpoint.** Nothing in the harness can check that they did.

This is the sharpest reason the [one rule](#the-one-rule-everything-else-follows-from) is the shape it
is. Azure's scheme would be a poor thing to hang a state change on; it is a perfectly adequate thing to
hang "re-read pull request 42" on.

## What the endpoint trusts

- **The credential**, and only for what the section above says it proves.
- **Nothing else.** The event name, the entity id, the branch name and every other field are read as
  attacker-controlled input (`src/ingress/delivery.ts`). Each id must parse as a positive integer
  within the range a tracker issues; anything else names nothing and the delivery does nothing.
- One delivery may name at most **16** entities. A `check_suite` legitimately lists several pull
  requests; a forged one could list a hundred thousand, and each would be a fan-out the next pulse
  pays for.

## What each event invalidates

The harness holds a per-entity hydration keyed by `pr:<n>` / `issue:<n>`
([04](04-harness-cycle.md#hot-and-cold)), so the whole of an event's meaning here is which of those
refs it names.

### GitHub, keyed off `X-GitHub-Event`

| Event                                                                                              | Invalidates                                                     |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | `pr:<pull_request.number>`                                      |
| `issues`                                                                                           | `issue:<issue.number>`                                          |
| `issue_comment`                                                                                    | `pr:<n>` when `issue.pull_request` is present, else `issue:<n>` |
| `check_run`, `check_suite`, `workflow_run`                                                         | `pr:<n>` for each entry of the check's `pull_requests`          |
| anything else (`push`, `status`, `ping`, …)                                                        | nothing, and no cycle                                           |

`issue_comment` is the one that needs care: GitHub numbers issues and pull requests out of one
sequence and delivers a comment on either as `issue_comment`. The `pull_request` sub-object is the only
thing that says which, and reading it wrong invalidates `issue:12` while the stale hydration is
`pr:12`'s — a miss that looks exactly like the webhook not being wired up.

An event that names no entity does nothing **and fires no cycle**, deliberately. A repository's `push`
traffic would otherwise set this fleet's provider spend, and a cycle that invalidates nothing sees
nothing a scheduled one would not have.

The known blind spot: GitHub leaves a check's `pull_requests` array empty for a pull request opened
from a **fork**, so a fork's builds are the one thing this endpoint cannot hear about. The slow lane
still covers them, on the same clock as before.

### Azure DevOps, keyed off the payload's own `eventType`

| Event                                       | Invalidates                                                          |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `git.pullrequest.*`                         | `pr:<resource.pullRequestId>`                                        |
| `ms.vss-code.git-pullrequest-comment-event` | `pr:<resource.pullRequest.pullRequestId>`                            |
| `workitem.*`                                | `issue:<resource.id>`                                                |
| `build.complete`                            | `pr:<n>` parsed from `resource.sourceBranch` = `refs/pull/<n>/merge` |
| anything else                               | nothing, and no cycle                                                |

Azure carries the event name **inside the body**, which is one more reason the body is read for a
number and nothing else: on Azure the caller chooses the event name too.

## Invalidating precisely

The invalidation is one line of policy, and it needed no new machinery.

Stage 1 made the per-entity read change-gated: `src/integrations/hydrationCache.ts` holds what the last
fan-out derived, keyed by entity id, beside a change token read off the cheap list payload. Stage 3
made the **age backstop** on that reuse a per-entity number the lane hands in per call
(`src/world/readPlan.ts`). So "drop this one entity's hydration" is already expressible: ask for it with
an age bound of **zero**, which is always past, and `get` deletes that one entry and returns nothing.

So the ingress marks refs into an `IngressInbox` (`src/ingress/inbox.ts`), the pulse drains it when it
builds the read plan, and `ReadPlan.fresh` carries them. `hydrationMaxAgeMs` answers `0` for a ref in
that set, **before** it consults the lanes:

- Nothing else in the cache is touched. Not the whole cache, not the entity's neighbours, not a
  fan-out for anything the delivery did not name.
- No integration grows a method, and no code path exists that could drop the whole cache by mistake.
- The ingress is not the set's only writer — the fleet's own finished work marks refs into it too
  ([04](04-harness-cycle.md#the-fresh-set)). Nothing here is special-cased for either: a ref is a ref.
- The `fresh` set beats the lane rather than widening it, and it has to: an entity a delivery names is
  usually one whose **change token has not moved** — a review left on a pull request does not touch its
  `updatedAt` — so anything short of overriding the reuse entirely would change nothing at all.

Three deliberate bounds on the inbox:

- It is **in memory**. A delivery is an optimisation over polling, so a restart that forgets one costs
  at most a cold lane's interval — and a durable queue of things to re-read would be a second source of
  truth about the world, with its own way of being wrong.
- It holds at most **512** refs. Over the cap a mark is dropped, not queued: the lane's backstop still
  re-reads that entity, so what is lost is latency on one entity and never correctness.
- It is drained when the plan is **built**, before the read it feeds. A read that then fails loses the
  invalidation, and that is the right trade rather than an oversight: holding refs until a read succeeds
  means a provider outage accumulates a re-read list that lands as one enormous fan-out on recovery.

## Triggering a pulse

**A verified delivery that named at least one entity asks for a real cycle** — `runCycle('ingress')`,
a fifth cycle source beside `timer`, `manual`, `boot` and `local`
([04](04-harness-cycle.md#the-local-cycle)).

It is never a [local cycle](04-harness-cycle.md#the-local-cycle), and the reason is definitional rather
than a matter of degree: a local cycle is the one that **does not read the world**, and the world is
exactly the thing a delivery came to announce. A local cycle here would run the whole decide/execute
sequence against the reading that predates the event, invalidate nothing it could see, and report a
pulse that learned nothing. There is no event kind for which that is the right answer, so there is no
branch.

`ingress` is named apart from `timer`/`manual` for what it says rather than what it does: this pulse
carries an invalidation the timer's does not, which is the fact worth having in the decision log.

## What a delivery is allowed to cost

This is the only unauthenticated, internet-facing surface in the product, so every bound it has is
stated here.

| Bound                 | Where                                      | Default | What it stops                                                                                                       |
| --------------------- | ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| Body size             | `ingress.maxBodyBytes`                     | 1 MiB   | An unbounded body. The only work an unverified caller buys is one bounded JSON parse and one constant-time compare. |
| Deliveries per minute | `ingress.requestsPerMinute`                | 600     | A flood of HMAC computations.                                                                                       |
| Burst → cycles        | `ingress.debounceMs`                       | 1s      | Four checks completing on one push becoming four cycles.                                                            |
| Floor between cycles  | `ingress.minCycleGapMs`                    | 5s      | A verified flood setting how often this fleet talks to its provider.                                                |
| Refs held             | `MAX_PENDING` (`src/ingress/inbox.ts`)     | 512     | A flood of distinct entity ids growing memory, or one pulse's fan-out.                                              |
| Refs per delivery     | `MAX_REFS` (`src/ingress/delivery.ts`)     | 16      | One forged payload naming a hundred thousand entities.                                                              |
| Replay ledger         | `REPLAY_LEDGER` (`src/ingress/ingress.ts`) | 2048    | A captured delivery curled back at the endpoint.                                                                    |

The debounce and the floor are the ingress's own numbers on the **same** trigger the local cycle uses
(`CycleTrigger`, `src/cycleTrigger.ts`); a request arriving inside the floor is **held until the floor
is up**, never dropped. A dropped request is a reason to cycle that nothing will raise again — the
delivery that would have named it has already been answered `200` — and the fleet would then wait for
the heartbeat with no sign anything was missed.

Five seconds caps an inbound flood at twelve real cycles a minute. That is roughly what a
thirty-second heartbeat costs six times over, which is well inside every provider budget worked
through in [15](15-integrations.md#what-the-cadence-costs).

**The rate limit is keyed to the endpoint, not to `req.ip`.** A webhook arrives from a provider's whole
address range, and per-caller keying on a public port is a budget an attacker multiplies by changing
address. What that trades away is that one noisy source can spend the budget a real delivery needed —
survivable precisely because polling is still the backstop.

**Refusals are recorded once per run.** The first `401` of a run goes to the error log with the likely
cause named; every one after it goes to the opt-in debug log under the `ingress` scope. `auth.ts`'s
reasoning, on a surface where it matters more: recording every refusal would hand a stranger the
ability to fill the operator's Errors panel.

### Replay

Neither provider signs a timestamp, so replay cannot be _prevented_ by verification and the ledger is a
mitigation rather than a proof. What there is: the delivery's id — `X-GitHub-Delivery`, or the `id`
field of an Azure payload — is remembered in a bounded, in-process set, and a repeat is answered `200`
with nothing done. It makes the naive replay a no-op. It is forgotten on restart, and the id is chosen
by the sender, so a determined replayer varies it.

What makes that acceptable is again the [one rule](#the-one-rule-everything-else-follows-from): the
whole effect of a successful replay is one entity re-read sooner, under the floor above.

### Left open, deliberately

- **No allow-list of provider address ranges.** It would be a fourth thing to keep current, it breaks
  the moment a deployment sits behind a proxy that rewrites the source address, and it protects nothing
  the signature does not.
- **Azure deliveries are not distinguishable from replays** beyond the payload's own `id`, because
  there is nothing else to distinguish them by.
- **The harness terminates no TLS.** An operator exposing this endpoint fronts it themselves.
- **A distributed flood is bounded by the cycle floor, not by the rate limit.** The floor is the bound
  that matters — it is the one standing between an attacker and this fleet's provider budget — and it
  holds regardless of how many addresses the flood comes from.

## Turning it on

The secrets come from the **environment and never from config**, for the reason `GITHUB_TOKEN`,
`AZURE_DEVOPS_PAT` and `LUBBDUBB_TOKEN` do: `lubbdubb.config.json` is the file an operator pastes into
an issue when asking for help ([02](02-configuration.md#secrets)).

| Variable                  | Provider     | Value                                          |
| ------------------------- | ------------ | ---------------------------------------------- |
| `LUBBDUBB_INGRESS_SECRET` | GitHub       | The webhook's shared secret.                   |
| `LUBBDUBB_INGRESS_BASIC`  | Azure DevOps | `user:password`, as the subscription sends it. |

**Their presence is the on switch.** There is no `ingress.enabled` key, because a boolean that can
disagree with the secret is a boolean that will: a deployment with neither variable set has no ingress,
and both routes answer `404` — which is what that path answered before the endpoint existed. Setting
one turns that provider's route on and leaves the other's at `404`.

So:

1. Expose the harness's port at a URL the provider can reach, with TLS in front of it.
2. Set the variable in the environment the harness is launched from, and restart it.
3. On GitHub: add a repository webhook to `https://…/ingress/github`, content type
   `application/json`, the same secret, and subscribe it to pull requests, pull request reviews and
   comments, issues, issue comments and check suites.
   On Azure DevOps: add a service-hook subscription per event to `https://…/ingress/azure` with basic
   authentication set to the same `user:password`.
4. Nothing else changes. The four `ingress.*` config keys ([02](02-configuration.md#the-ingress-keys))
   are the bounds it runs under and have defaults; they are drawn on the config page whether or not the
   endpoint is on, so an operator can see what it will cost before turning it on.

To turn it off: unset the variable and restart. The fleet returns to the cadence it had, with no other
change of behaviour anywhere.
