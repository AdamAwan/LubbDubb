import { debugLog } from '../debug.js';
import type { ErrorRecorder } from '../errorLog.js';
import { azureEffect, githubEffect } from './delivery.js';
import type { IngressInbox } from './inbox.js';
import { verifyBasicCredential, verifyGitHubSignature } from './signature.js';

// → docs/spec/30-ingress.md

export type IngressProvider = 'github' | 'azure';

type IngressVerdict =
  | { ok: true; refs: readonly string[]; summary: string }
  | { ok: false; status: 401 | 404; error: string };

interface IngressDelivery {
  raw: Buffer;
  body: unknown;
  signature?: string;
  authorization?: string;
  event?: string;
  deliveryId?: string;
}

export interface IngressSecrets {
  github?: string;
  azure?: string;
}

export function resolveIngressSecrets(env: NodeJS.ProcessEnv = process.env): IngressSecrets {
  return {
    github: env.LUBBDUBB_INGRESS_SECRET?.trim() || undefined,
    azure: env.LUBBDUBB_INGRESS_BASIC?.trim() || undefined,
  };
}

const REPLAY_LEDGER = 2_048;

interface IngressDeps {
  secrets: IngressSecrets;
  inbox: IngressInbox;
  trigger?: { request(): void };
  errors: ErrorRecorder;
}

export class Ingress {
  private readonly seen = new Set<string>();
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

  handle(provider: IngressProvider, delivery: IngressDelivery): IngressVerdict {
    const secret = this.secretFor(provider);
    if (secret === undefined) return { ok: false, status: 404, error: 'not found' };

    const verified =
      provider === 'github'
        ? verifyGitHubSignature(secret, delivery.raw, delivery.signature)
        : verifyBasicCredential(secret, delivery.authorization);
    if (!verified) return this.refuse(provider, 'the delivery carried no valid credential');

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
    this.deps.trigger?.request();
    return { ok: true, refs: effect.refs, summary: effect.summary };
  }

  private secretFor(provider: IngressProvider): string | undefined {
    return provider === 'github' ? this.deps.secrets.github : this.deps.secrets.azure;
  }

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

  private remember(id: string): void {
    this.seen.add(id);
    while (this.seen.size > REPLAY_LEDGER) {
      const oldest = this.seen.values().next();
      if (oldest.done === true) break;
      this.seen.delete(oldest.value);
    }
  }
}

function bodyId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const id: unknown = Reflect.get(body, 'id');
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : undefined;
}
