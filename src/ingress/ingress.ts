import { debugLog } from '../debug.js';
import type { ErrorRecorder } from '../errorLog.js';
import { azureEffect, githubEffect } from './delivery.js';
import type { IngressInbox } from './inbox.js';
import { verifyBasicCredential, verifyGitHubSignature } from './signature.js';

/**
 * Event-driven ingress: the harness hearing about a review comment or a finished
 * build **as it happens**, rather than up to a heartbeat later.
 *
 * Polling is cheap since stage 1 and adaptive since stage 3, but it is still a
 * clock, and a clock is latency by construction. A webhook costs no polling at all
 * and arrives in the second the thing happened.
 *
 * **The slow lane stays, and correctness does not depend on any delivery
 * arriving.** Deliveries are dropped, endpoints go down, secrets rotate, and a
 * fleet behind a firewall receives none at all — so this is strictly an
 * accelerator over the timer, and a deployment with no ingress secret in its
 * environment behaves exactly as it did before this existed.
 * → `docs/spec/30-ingress.md`
 */

/** Which provider's delivery format a request is being read as. */
export type IngressProvider = 'github' | 'azure';

/**
 * The endpoint's answer, as a value. A refusal is a status and a sentence, never a
 * throw — the same discipline the rest of the HTTP surface holds
 * (`src/server/validation.ts`), and here it also matters that a refused delivery
 * costs the error handler nothing: this port is reachable by anyone.
 */
type IngressVerdict =
  | { ok: true; refs: readonly string[]; summary: string }
  | { ok: false; status: 401 | 404; error: string };

/** One delivery, as the route hands it over: raw bytes, parsed body, and the headers read. */
interface IngressDelivery {
  /** The exact bytes the signature covers. Never a re-serialisation of `body`. */
  raw: Buffer;
  /** The same bytes parsed. Untrusted throughout — see `src/ingress/delivery.ts`. */
  body: unknown;
  /** `X-Hub-Signature-256`. */
  signature?: string;
  /** `Authorization`, for Azure's basic credential. */
  authorization?: string;
  /** `X-GitHub-Event`. Azure's event name is in the body instead. */
  event?: string;
  /** `X-GitHub-Delivery` — the id the replay ledger is kept on. */
  deliveryId?: string;
}

/**
 * The secrets, from the environment and **never from config**.
 *
 * `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and `LUBBDUBB_TOKEN` are already out of
 * `lubbdubb.config.json` so that file stays safe to paste into an issue; a webhook
 * secret is the same kind of thing and follows the same rule.
 * → `docs/spec/02-configuration.md#secrets`
 *
 * Their presence is also the on switch. There is no `ingress.enabled` to disagree
 * with them: a deployment that has set neither variable has no ingress, and the
 * endpoint answers `404` — which is what an unconfigured deployment answered for
 * that path before this existed.
 */
export interface IngressSecrets {
  /** `LUBBDUBB_INGRESS_SECRET` — the HMAC secret shared with the GitHub webhook. */
  github?: string;
  /** `LUBBDUBB_INGRESS_BASIC` — `user:password`, as the Azure subscription sends it. */
  azure?: string;
}

/** Read the two secrets out of the environment. Blank is the same as unset. */
export function resolveIngressSecrets(env: NodeJS.ProcessEnv = process.env): IngressSecrets {
  return {
    github: env.LUBBDUBB_INGRESS_SECRET?.trim() || undefined,
    azure: env.LUBBDUBB_INGRESS_BASIC?.trim() || undefined,
  };
}

/**
 * How many delivery ids the replay ledger remembers.
 *
 * A mitigation, not a proof: neither provider signs a timestamp, so a captured
 * delivery verifies forever and the only thing distinguishing a replay is an id
 * the sender also chose. It is worth having anyway — it makes the naive replay (a
 * captured request curled back at the endpoint) a no-op — and it is worth being
 * precise that it is bounded, in-process, and forgotten on restart.
 * → `docs/spec/30-ingress.md#replay`
 */
const REPLAY_LEDGER = 2_048;

interface IngressDeps {
  secrets: IngressSecrets;
  inbox: IngressInbox;
  /** Asks for a real cycle, debounced and floored. Absent in the unit tests of the verdict. */
  trigger?: { request(): void };
  errors: ErrorRecorder;
}

export class Ingress {
  private readonly seen = new Set<string>();
  /** The first refusal of a run is recorded; the rest go to the debug log. See {@link refuse}. */
  private recorded = false;

  constructor(private readonly deps: IngressDeps) {}

  /**
   * Whether this deployment has an ingress at all — used by the route to answer a
   * request for a provider nobody configured, and by nothing else.
   * @public the route module (`src/server/routes/ingress.ts`)
   */
  configured(provider: IngressProvider): boolean {
    return this.secretFor(provider) !== undefined;
  }

  /**
   * Verify one delivery, invalidate exactly what it names, and ask for a pulse.
   *
   * The order is the security property. Nothing about the payload is read until
   * the credential has been checked — the only work an unverified caller buys is a
   * bounded JSON parse (the body is capped by the route's `bodyLimit`) and one
   * constant-time comparison.
   */
  handle(provider: IngressProvider, delivery: IngressDelivery): IngressVerdict {
    const secret = this.secretFor(provider);
    // Not "ingress disabled": a `404` is what this path answered before the feature
    // existed, and an endpoint that announces which providers it is listening for
    // is telling an unauthenticated caller something it has no reason to.
    if (secret === undefined) return { ok: false, status: 404, error: 'not found' };

    const verified =
      provider === 'github'
        ? verifyGitHubSignature(secret, delivery.raw, delivery.signature)
        : verifyBasicCredential(secret, delivery.authorization);
    if (!verified) return this.refuse(provider, 'the delivery carried no valid credential');

    // Azure names its own event inside the body, so the id it is de-duplicated on
    // comes from there too. Both are the sender's choice, which is exactly what the
    // ledger's docs say it is worth.
    const id = delivery.deliveryId ?? bodyId(delivery.body);
    if (id !== undefined && this.seen.has(id)) {
      debugLog('ingress', `replayed delivery ${JSON.stringify(id)} ignored`);
      return { ok: true, refs: [], summary: 'replay' };
    }
    if (id !== undefined) this.remember(id);

    const effect =
      provider === 'github' ? githubEffect(delivery.event ?? '', delivery.body) : azureEffect(delivery.body);
    debugLog('ingress', `${provider} ${effect.summary} -> ${effect.refs.join(', ') || '(nothing)'}`);
    if (effect.refs.length === 0) return { ok: true, refs: [], summary: effect.summary };

    this.deps.inbox.mark(effect.refs);
    // A **real** cycle, always. Every event that reaches here is a fact about the
    // outside world, and a local cycle is defined by not reading it — so a local one
    // could not see the thing the delivery came to announce. The floor on how often
    // this may fire is the trigger's, not this method's.
    // → `docs/spec/30-ingress.md#triggering-a-pulse`
    this.deps.trigger?.request();
    return { ok: true, refs: effect.refs, summary: effect.summary };
  }

  private secretFor(provider: IngressProvider): string | undefined {
    return provider === 'github' ? this.deps.secrets.github : this.deps.secrets.azure;
  }

  /**
   * A refusal, recorded once per run and logged thereafter.
   *
   * `auth.ts`'s reasoning, on a surface where it matters more: this port is
   * reachable by anyone, so recording every refusal hands a stranger the ability to
   * fill the operator's Errors panel. The first one is the one that says a secret
   * has been rotated on one side only, which is the failure worth seeing.
   */
  private refuse(provider: IngressProvider, error: string): IngressVerdict {
    if (this.recorded) {
      debugLog('ingress', `${provider}: ${error}`);
    } else {
      this.recorded = true;
      this.deps.errors.record({
        source: 'server',
        message: `an inbound ${provider} delivery was refused — the first of this run`,
        detail: [
          error,
          'The usual cause is a secret set on one side only. GitHub signs with LUBBDUBB_INGRESS_SECRET; Azure sends LUBBDUBB_INGRESS_BASIC as basic auth.',
          'Set LUBBDUBB_DEBUG=1 to log every refusal, not just the first.',
        ].join('\n'),
      });
    }
    return { ok: false, status: 401, error };
  }

  /** Insertion-ordered, so the oldest id is the one evicted. */
  private remember(id: string): void {
    this.seen.add(id);
    while (this.seen.size > REPLAY_LEDGER) {
      const oldest = this.seen.values().next();
      if (oldest.done === true) break;
      this.seen.delete(oldest.value);
    }
  }
}

/** Azure's own delivery id, when the body carries a plausible one. */
function bodyId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const id: unknown = Reflect.get(body, 'id');
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : undefined;
}
