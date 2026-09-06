import type { Plan, PlanPart, PullRequest, StackLanding } from '../types.js';
import { buildStacks } from './stack.js';

/**
 * The pure half of landing a stack: whether the click may be offered, what it authorizes,
 * and what the world has since made of it.
 */

/** Why a rung is not clear, or null when it is. */
interface RungVerdict {
  clear: boolean;
  blockedBy: string | null;
}

/**
 * Whether a rung is clear enough to *authorize* — the gate in front of the button, asked of
 * every rung. → `docs/spec/07-pull-requests.md#landing-a-stack`
 */
function rungVerdict(pr: PullRequest): RungVerdict {
  if (pr.ciStatus === 'failing') return { clear: false, blockedBy: `#${pr.number} CI failing` };
  if (pr.ciStatus !== 'passing') return { clear: false, blockedBy: `#${pr.number} checks not reported yet` };
  if (pr.approved !== true) return { clear: false, blockedBy: `#${pr.number} not approved` };
  const unresolved = pr.unresolvedComments.filter((c) => !c.handled).length;
  if (unresolved > 0)
    return {
      clear: false,
      blockedBy: `#${pr.number} has ${unresolved} unresolved comment${unresolved === 1 ? '' : 's'}`,
    };
  if (pr.mergeable === false || pr.mergeableState === 'dirty')
    return { clear: false, blockedBy: `#${pr.number} conflicts with its base` };
  if (pr.mergeableState === 'blocked')
    return { clear: false, blockedBy: `#${pr.number} merge blocked (required checks/reviews)` };
  // Not folded into the conflict arm: `false` is the provider saying the merge will not go
  // through, absent is it not having said. Different sentence, so the operator waits.
  if (pr.mergeable !== true)
    return { clear: false, blockedBy: `#${pr.number} — the provider reports no mergeable state` };
  return { clear: true, blockedBy: null };
}

/**
 * Whether a rung has *gone wrong* since it was authorized — the gate that stops a standing
 * intent, and pointedly **not** the negation of {@link rungVerdict}. Pending CI must not: a
 * retarget re-runs checks, so stopping there would stop every intent at its first success.
 * Likewise an absent `approved` is unknown, not a withdrawal — only an explicit `false` counts.
 */
export function rungFault(pr: PullRequest): string | null {
  if (pr.ciStatus === 'failing') return `#${pr.number} CI failing`;
  if (pr.approved === false) return `#${pr.number} approval withdrawn`;
  const unresolved = pr.unresolvedComments.filter((c) => !c.handled).length;
  if (unresolved > 0) return `#${pr.number} has ${unresolved} unresolved comment${unresolved === 1 ? '' : 's'}`;
  if (pr.mergeable === false || pr.mergeableState === 'dirty') return `#${pr.number} conflicts with its base`;
  return null;
}

/** The button's gate: every rung clear, or it is not offered — disabled, not warned about. */
export function landingReadiness(rungPrs: PullRequest[]): { offer: boolean; blockedBy: string | null } {
  for (const pr of rungPrs) {
    const verdict = rungVerdict(pr);
    if (!verdict.clear) return { offer: false, blockedBy: verdict.blockedBy };
  }
  return { offer: rungPrs.length > 0, blockedBy: null };
}

/**
 * Resolve a stack ref to the rungs a click over it authorizes — consulted at the click and
 * never again; everything downstream keys on the PR numbers this returns. The client sends
 * the ref alone, so the scope of an authorization is never something a caller supplied.
 */
export function landingScope(
  ref: string,
  openPrs: PullRequest[],
  plans: Plan[],
  parts: PlanPart[],
  defaultBranch: string,
): { ok: true; rungs: number[]; prs: PullRequest[] } | { ok: false; error: string } {
  const stack = buildStacks(openPrs, plans, parts, defaultBranch).find((s) => s.ref === ref);
  if (!stack) return { ok: false, error: `no open stack ${ref}` };
  const prs = stack.rungs.map((rung) => openPrs.find((pr) => pr.number === rung.prNumber));
  // Unreachable today, and checked anyway: a scope with a hole would authorize a chain the
  // operator was never shown.
  if (prs.some((pr) => pr === undefined))
    return { ok: false, error: `stack ${ref} names a pull request that is not open` };
  return { ok: true, rungs: stack.rungs.map((r) => r.prNumber), prs: prs as PullRequest[] };
}

/** What a pulse made of one standing intent. */
interface LandingSettlement {
  landing: StackLanding;
  status: 'landed' | 'stopped';
  reason: string | null;
}

/**
 * The world a settlement is judged against — open and recently-closed pull requests, plus
 * the durable record of what has merged. `closedPullRequests` is a window that forgets after
 * `closedPrWindowMs`, so "left the open set without merging" must be judged against `merged`,
 * which does not.
 */
interface SettleWorld {
  pullRequests: PullRequest[];
  closedPullRequests?: PullRequest[];
  /** The integrations that served a fallback slice on this pulse; any stale source stops a settle. */
  staleSources?: string[];
  /** Pull requests durably recorded as merged — `Store.mergedPrs()`. */
  merged?: ReadonlySet<number>;
}

/**
 * Whether this pulse's world may end an operator's standing authorization. A stale slice
 * under-reports, and a settle is **not idempotent** — one bad read would revoke the
 * authorization permanently. → `docs/spec/03-world-model.md#worldsnapshot`
 */
function settleable(world: SettleWorld): boolean {
  return (world.staleSources ?? []).length === 0;
}

/**
 * What the world has made of each standing intent: finished, stopped, or neither. Never calls
 * `buildStacks` — the chain is re-read from the intent's own rung numbers. Check order is
 * load-bearing: a rung that left the open set is settled before the survivors are examined
 * for a fault.
 */
export function settleLandings(landings: StackLanding[], world: SettleWorld): LandingSettlement[] {
  if (!settleable(world)) return [];
  const open = new Map<number, PullRequest>();
  for (const pr of world.pullRequests) if (!pr.merged) open.set(pr.number, pr);
  const closed = new Map<number, PullRequest>();
  for (const pr of world.closedPullRequests ?? []) closed.set(pr.number, pr);
  // A merged rung can be reported either way for a pulse or two, and after that neither:
  // the durable record is the only thing that still remembers, so it is asked first.
  const merged = (n: number): boolean => {
    if (world.merged?.has(n) === true) return true;
    const pr = world.pullRequests.find((p) => p.number === n) ?? closed.get(n);
    return pr !== undefined && (pr.merged === true || pr.state === 'merged');
  };

  const settlements: LandingSettlement[] = [];
  for (const landing of landings) {
    const remaining = landing.rungs.filter((n) => !merged(n));
    if (remaining.length === 0) {
      settlements.push({ landing, status: 'landed', reason: null });
      continue;
    }
    // Neither open nor merged means the rung left the chain some other way, so the intent
    // cannot finish. Reached only after the durable record has been asked: the window
    // forgetting a merge is not the chain losing a rung.
    const gone = remaining.find((n) => !open.has(n));
    if (gone !== undefined) {
      settlements.push({
        landing,
        status: 'stopped',
        reason: `#${gone} is no longer open and nothing says it merged`,
      });
      continue;
    }
    const fault = remaining.map((n) => rungFault(open.get(n)!)).find((f) => f !== null);
    if (fault) settlements.push({ landing, status: 'stopped', reason: fault });
  }
  return settlements;
}

/**
 * The intent covering a chain the cockpit is drawing, matched by **rung overlap and not by
 * ref**: `stack:<bottom PR>` renames itself the instant the bottom rung merges, which would
 * lose the intent at the first success. `openPrNumbers` disambiguates forks — an intent
 * covering a rung that is still open and not in this chain belongs to some other chain.
 */
export function landingFor(
  rungPrNumbers: number[],
  landings: StackLanding[],
  openPrNumbers?: ReadonlySet<number>,
): StackLanding | null {
  const elsewhere = (l: StackLanding): boolean =>
    openPrNumbers !== undefined && l.rungs.some((n) => openPrNumbers.has(n) && !rungPrNumbers.includes(n));
  return landings.find((l) => l.rungs.some((n) => rungPrNumbers.includes(n)) && !elsewhere(l)) ?? null;
}

/** How many of an intent's rungs have landed — the numerator of "landing 1 of 3". */
export function landedCount(landing: StackLanding, world: SettleWorld): number {
  const byNumber = new Map<number, PullRequest>();
  for (const pr of [...(world.closedPullRequests ?? []), ...world.pullRequests]) byNumber.set(pr.number, pr);
  return landing.rungs.filter((n) => {
    // The durable record first: read off the window alone, "landing 1 of 3" would count
    // back down to 0 of 3 as rungs age out.
    if (world.merged?.has(n) === true) return true;
    const pr = byNumber.get(n);
    return pr !== undefined && (pr.merged === true || pr.state === 'merged');
  }).length;
}
