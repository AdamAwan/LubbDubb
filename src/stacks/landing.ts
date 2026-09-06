import type { Plan, PlanPart, PullRequest, StackLanding } from '../types.js';
import { buildStacks } from './stack.js';

// → docs/spec/07-pull-requests.md

interface RungVerdict {
  clear: boolean;
  blockedBy: string | null;
}

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
  if (pr.mergeable !== true)
    return { clear: false, blockedBy: `#${pr.number} — the provider reports no mergeable state` };
  return { clear: true, blockedBy: null };
}

export function rungFault(pr: PullRequest): string | null {
  if (pr.ciStatus === 'failing') return `#${pr.number} CI failing`;
  if (pr.approved === false) return `#${pr.number} approval withdrawn`;
  const unresolved = pr.unresolvedComments.filter((c) => !c.handled).length;
  if (unresolved > 0) return `#${pr.number} has ${unresolved} unresolved comment${unresolved === 1 ? '' : 's'}`;
  if (pr.mergeable === false || pr.mergeableState === 'dirty') return `#${pr.number} conflicts with its base`;
  return null;
}

export function landingReadiness(rungPrs: PullRequest[]): { offer: boolean; blockedBy: string | null } {
  for (const pr of rungPrs) {
    const verdict = rungVerdict(pr);
    if (!verdict.clear) return { offer: false, blockedBy: verdict.blockedBy };
  }
  return { offer: rungPrs.length > 0, blockedBy: null };
}

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
  if (prs.some((pr) => pr === undefined))
    return { ok: false, error: `stack ${ref} names a pull request that is not open` };
  return { ok: true, rungs: stack.rungs.map((r) => r.prNumber), prs: prs as PullRequest[] };
}

interface LandingSettlement {
  landing: StackLanding;
  status: 'landed' | 'stopped';
  reason: string | null;
}

interface SettleWorld {
  pullRequests: PullRequest[];
  closedPullRequests?: PullRequest[];
  staleSources?: string[];
  merged?: ReadonlySet<number>;
}

function settleable(world: SettleWorld): boolean {
  return (world.staleSources ?? []).length === 0;
}

export function settleLandings(landings: StackLanding[], world: SettleWorld): LandingSettlement[] {
  if (!settleable(world)) return [];
  const open = new Map<number, PullRequest>();
  for (const pr of world.pullRequests) if (!pr.merged) open.set(pr.number, pr);
  const closed = new Map<number, PullRequest>();
  for (const pr of world.closedPullRequests ?? []) closed.set(pr.number, pr);
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

export function landingFor(
  rungPrNumbers: number[],
  landings: StackLanding[],
  openPrNumbers?: ReadonlySet<number>,
): StackLanding | null {
  const elsewhere = (l: StackLanding): boolean =>
    openPrNumbers !== undefined && l.rungs.some((n) => openPrNumbers.has(n) && !rungPrNumbers.includes(n));
  return landings.find((l) => l.rungs.some((n) => rungPrNumbers.includes(n)) && !elsewhere(l)) ?? null;
}

export function landedCount(landing: StackLanding, world: SettleWorld): number {
  const byNumber = new Map<number, PullRequest>();
  for (const pr of [...(world.closedPullRequests ?? []), ...world.pullRequests]) byNumber.set(pr.number, pr);
  return landing.rungs.filter((n) => {
    if (world.merged?.has(n) === true) return true;
    const pr = byNumber.get(n);
    return pr !== undefined && (pr.merged === true || pr.state === 'merged');
  }).length;
}
