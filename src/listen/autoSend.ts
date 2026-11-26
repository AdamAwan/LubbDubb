import type { Listener } from './listener.js';
import type { ListenPolicy } from './policy.js';
import { prOnYouReasons } from './prsOnYou.js';
import type { AutoSendWhy } from '../types.js';
import type { OpenPullRequest } from '../wire.js';

// → docs/spec/44-needs-you.md#sending-by-itself

function ciAllGreen(pr: OpenPullRequest): boolean {
  if (pr.ciStatus !== 'passing' || pr.ciChecksWithheld === true) return false;
  return (pr.ciChecks ?? []).every((check) => check.status === 'passing');
}

/** Why the pull request would be sent by itself, or null when it would not be. */
export function autoSendWhy(pr: OpenPullRequest): AutoSendWhy | null {
  if (!ciAllGreen(pr)) return null;
  const reasons = prOnYouReasons(pr);
  if (reasons.includes('review')) return 'review';
  if (reasons.includes('call') || reasons.includes('assign')) return 'ready';
  const yoursIdle = pr.viewerAuthored === true && pr.attention.status !== 'harness' && pr.attention.status !== 'done';
  return yoursIdle ? 'ready' : null;
}

export class AutoSend {
  private seen = new Map<number, Set<AutoSendWhy>>();
  private primed = false;

  constructor(
    private readonly listener: Pick<Listener, 'send'>,
    private readonly policy: () => ListenPolicy,
  ) {}

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
      if (why === null || !(why === 'review' ? policy.autoSendReviews : policy.autoSendReady)) continue;
      const seen = this.seen.get(pr.number) ?? new Set<AutoSendWhy>();
      if (seen.has(why)) continue;
      this.seen.set(pr.number, seen.add(why));
      if (this.primed) this.listener.send({ kind: 'pr', number: pr.number, why });
    }
    const open = new Set(prs.map((pr) => pr.number));
    for (const number of this.seen.keys()) if (!open.has(number)) this.seen.delete(number);
    this.primed = true;
  }
}
