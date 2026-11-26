import type { ErrorRecorder } from '../errorLog.js';
import type { Listener } from './listener.js';
import type { AutoSendWhy } from '../types.js';
import type { OpenPullRequest } from '../wire.js';

// → docs/spec/44-needs-you.md#sending-by-itself

export interface ListenPolicy {
  autoSendReviews: boolean;
  autoSendReady: boolean;
  /** The skill a pull request is talked through with; empty is `/lubbdubb:pr`. */
  prSkill: string;
}

export const DEFAULT_LISTEN: ListenPolicy = { autoSendReviews: false, autoSendReady: false, prSkill: '' };

export const DEFAULT_PR_SKILL = '/lubbdubb:pr';

function ciAllGreen(pr: OpenPullRequest): boolean {
  if (pr.ciStatus !== 'passing' || pr.ciChecksWithheld === true) return false;
  return (pr.ciChecks ?? []).every((check) => check.status === 'passing');
}

/** Why the pull request would be sent by itself, or null when it would not be. */
export function autoSendWhy(pr: OpenPullRequest): AutoSendWhy | null {
  if (!ciAllGreen(pr)) return null;
  if (pr.viewerAssignment !== undefined && pr.viewerAuthored !== true && pr.viewerApproved !== true) return 'review';
  if (pr.attention.status === 'harness' || pr.attention.assignedToYou !== undefined) return null;
  const yours = pr.viewerAuthored === true || pr.attention.status === 'you' || (pr.assignAsk?.length ?? 0) > 0;
  return yours ? 'ready' : null;
}

function wanted(policy: ListenPolicy, why: AutoSendWhy): boolean {
  return why === 'review' ? policy.autoSendReviews : policy.autoSendReady;
}

export class AutoSend {
  private seen = new Set<string>();
  private primed = false;

  constructor(
    private readonly listener: Pick<Listener, 'send'>,
    private readonly policy: () => ListenPolicy,
  ) {}

  /** Observes at every `cycle:end`, recording what fails rather than throwing into the harness. */
  follow(
    harness: { on(event: 'cycle:end', fn: () => void): unknown },
    openPrs: () => readonly OpenPullRequest[],
    errors: ErrorRecorder,
  ): void {
    harness.on('cycle:end', () => {
      try {
        this.observe(openPrs);
      } catch (err) {
        errors.record({ source: 'cycle', message: `Listen auto-send failed: ${(err as Error).message}` });
      }
    });
  }

  /** Reads the open pull requests only while either kind of sending is on. */
  observe(openPrs: () => readonly OpenPullRequest[]): void {
    const policy = this.policy();
    if (!policy.autoSendReviews && !policy.autoSendReady) {
      this.seen.clear();
      this.primed = false;
      return;
    }
    const prs = openPrs();
    for (const pr of prs) {
      const why = autoSendWhy(pr);
      if (why === null || !wanted(policy, why)) continue;
      const key = `${pr.number}:${why}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.primed) this.listener.send({ kind: 'pr', number: pr.number, why });
    }
    const numbers = new Set(prs.map((pr) => String(pr.number)));
    for (const key of this.seen) if (!numbers.has(key.split(':')[0]!)) this.seen.delete(key);
    this.primed = true;
  }
}
