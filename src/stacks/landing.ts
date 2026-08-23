import type { Plan, PlanPart, PullRequest, StackLanding } from '../types.js';
import { buildStacks } from './stack.js';

/**
 * The pure half of landing a stack: whether the click may be offered, what it
 * authorizes, and what the world has since made of it. No store and no sink, so
 * the three questions that decide whether this feature is safe are testable on
 * their own — the shape `src/proposals/proposals.ts` takes for the same reason.
 *
 * **Nothing here merges anything.** Rule `pr-merge-ready` proposes exactly one
 * merge per chain (the bottom rung — the only one whose base is the integration
 * branch), and a rung becomes proposable only once the one beneath it has landed
 * and the provider has retargeted it, which is observed on a later pulse. So the
 * chain already lands bottom-up across cycles; a {@link StackLanding} only keeps
 * answering yes. A loop over rungs here would either block on a retarget that
 * has not happened, or merge the bottom rung and report three.
 */

/** Why a rung is not clear, or null when it is. */
interface RungVerdict {
  clear: boolean;
  blockedBy: string | null;
}

/**
 * Whether a rung is clear enough to *authorize* — the gate in front of the
 * button, asked of every rung including the ones that cannot merge for a while
 * yet.
 *
 * **`behind` is the one exclusion, and the argument for it is only about
 * `behind`.** A rung is behind precisely because the rung beneath it has not
 * landed, and it clears itself the moment the provider retargets. Counting it
 * would withhold the button from every real stack, which is the feature not
 * existing. The line this draws is worth keeping: the operator is authorizing
 * *code they have read*, and `behind` is a fact about the queue, not about the
 * code.
 *
 * **Everything else rule `pr-merge-ready` refuses is consulted, because this gate
 * must be no weaker than that test on anything that does not clear itself.**
 * Where the two disagree there is no exit: the button is offered, the click is
 * accepted, no merge is ever proposed — the rule requires `mergeable === true`
 * and a state that is not `blocked` — and {@link rungFault} does not stop the
 * intent either, so it stands at "landing 0 of N" forever with no escalation and
 * no reason. That silence is the exact failure `settleLandings` exists to make
 * impossible. `blocked` is not a fact about the queue: `prAttentionStatus` reads
 * it as a required check or reviewer a person has to resolve, and a rung held
 * back by its parent reports `behind` rather than `blocked`, so excluding it buys
 * nothing the `behind` exclusion does not already buy. An absent `mergeable` is
 * the provider still computing — reachable in normal operation, since a retarget
 * triggers a recompute — and it resolves itself, so the button simply returns on
 * the pulse it does. → `docs/spec/07-pull-requests.md#landing-a-stack`
 *
 * The checks run in the order an operator would ask them, so the sentence the
 * rack shows names the thing furthest from ready.
 *
 * {@link rungFault} deliberately gains neither: the offer gate is strict and the
 * stop gate needs a *definite* adverse verdict, which is the one state the two
 * must differ on.
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
  // Not folded into the conflict arm above: `false` is the provider saying the
  // merge will not go through, and absent is it not having said. The operator
  // reads a different sentence and waits rather than goes looking.
  if (pr.mergeable !== true)
    return { clear: false, blockedBy: `#${pr.number} — the provider reports no mergeable state` };
  return { clear: true, blockedBy: null };
}

/**
 * Whether a rung has *gone wrong* since it was authorized — the gate that stops a
 * standing intent, and pointedly **not** the negation of {@link rungVerdict}.
 *
 * The two must differ on one state: CI that is pending or unreported. Retargeting
 * a rung onto its new base re-runs its checks, so every rung goes through
 * `pending` on the way to landing. Stopping there would stop every intent at its
 * first success — the feature killing itself the moment it worked. So waiting is
 * waiting, and only a definite adverse verdict stops the chain.
 *
 * `approved` absent means the provider has not said, which is not a withdrawal.
 * Only an explicit `false` counts, the same "absent = unknown" reading the rest
 * of the world model takes.
 */
export function rungFault(pr: PullRequest): string | null {
  if (pr.ciStatus === 'failing') return `#${pr.number} CI failing`;
  if (pr.approved === false) return `#${pr.number} approval withdrawn`;
  const unresolved = pr.unresolvedComments.filter((c) => !c.handled).length;
  if (unresolved > 0) return `#${pr.number} has ${unresolved} unresolved comment${unresolved === 1 ? '' : 's'}`;
  if (pr.mergeable === false || pr.mergeableState === 'dirty') return `#${pr.number} conflicts with its base`;
  return null;
}

/**
 * The button's gate: every rung clear, or it is not offered.
 *
 * Not offered-and-warning — **disabled**. Offering it while a rung above the
 * bottom is unread would authorize merging code whose ladder the operator cannot
 * see, which is the one thing a standing authorization must not do.
 *
 * Decided here, on the server, and shipped to the cockpit rather than re-derived
 * there: the route re-asks this same function before recording, because a
 * disabled button is a courtesy and not a gate. Two readers, one answer.
 */
export function landingReadiness(rungPrs: PullRequest[]): { offer: boolean; blockedBy: string | null } {
  for (const pr of rungPrs) {
    const verdict = rungVerdict(pr);
    if (!verdict.clear) return { offer: false, blockedBy: verdict.blockedBy };
  }
  return { offer: rungPrs.length > 0, blockedBy: null };
}

/**
 * Resolve a stack ref to the rungs a click over it authorizes — the one place the
 * stack model is consulted on this path, and it is consulted at the click and
 * never again. Everything downstream keys on the PR numbers this returns.
 *
 * The client sends the ref alone. The rungs are the server's own reading, so the
 * scope of an authorization is never something a caller supplied.
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
  // Unreachable while `buildStacks` folds the very list being searched, and
  // checked anyway: a scope with a hole in it would authorize a chain the
  // operator was never shown, which is the one error worth being loud about.
  if (prs.some((pr) => pr === undefined))
    return { ok: false, error: `stack ${ref} names a pull request that is not open` };
  return { ok: true, rungs: stack.rungs.map((r) => r.prNumber), prs: prs as PullRequest[] };
}

/** What a pulse made of one standing intent. `null` where it still stands. */
interface LandingSettlement {
  landing: StackLanding;
  status: 'landed' | 'stopped';
  reason: string | null;
}

/**
 * The world a settlement is judged against — open and recently-closed pull
 * requests, plus the durable record of what has merged.
 *
 * `closedPullRequests` is a **window**: it carries a merge for `closedPrWindowMs`
 * and then forgets. `merged` is the record that does not, and it is what "left the
 * open set without merging" has to be judged against — an intent outlives the
 * window whenever a chain takes more than a few hours to land, which is every
 * chain tall enough for the feature to be worth using.
 */
interface SettleWorld {
  pullRequests: PullRequest[];
  closedPullRequests?: PullRequest[];
  /**
   * The integrations that served a fallback slice on this pulse. Named per
   * integration rather than per slice, so there is no way to ask whether it was
   * the *source-control* half that went old — which is why any stale source at
   * all stops a settle rather than only a stale one.
   */
  staleSources?: string[];
  /** Pull requests durably recorded as merged — `Store.mergedPrs()`. */
  merged?: ReadonlySet<number>;
}

/**
 * Whether this pulse's world may end an operator's standing authorization.
 *
 * A world with a stale slice is exactly the world in which rungs go missing: a
 * provider serving its last-good list under-reports, and `settleLandings` reads
 * every rung it cannot find as gone. Unlike the other folds that read absence, a
 * settle is **not idempotent** — `settleStackLanding` is a compare-and-set onto a
 * terminal status, and the next healthy pulse does not put the intent back. So
 * one bad read would revoke the authorization permanently, over a pull request
 * that never changed, with a reason that is false about it.
 *
 * Both arms skip, not just the stop: "all rungs merged" is just as unsupportable
 * from a world nobody could read as "a rung is gone" is. The durable `merged`
 * record does not rescue it either: it says which rungs landed, never that the
 * ones missing from an under-reported world have gone.
 * → `docs/spec/03-world-model.md#worldsnapshot`
 */
function settleable(world: SettleWorld): boolean {
  return (world.staleSources ?? []).length === 0;
}

/**
 * What the world has made of each standing intent: finished, stopped, or neither.
 *
 * **It never calls `buildStacks`.** The intent carries its rungs' numbers, so the
 * chain is re-read from the numbers and the world rather than re-derived, which
 * is what keeps the stack lens out of the harness's per-pulse decision path.
 *
 * The order of the checks is the order they matter in. A rung that left the open
 * set is settled first — merged is progress, anything else is a fact about the
 * chain that outranks whatever the remaining rungs look like — and only then are
 * the survivors examined for a fault.
 *
 * **Nothing is settled from a world a provider disowned** ({@link settleable}).
 */
export function settleLandings(landings: StackLanding[], world: SettleWorld): LandingSettlement[] {
  if (!settleable(world)) return [];
  const open = new Map<number, PullRequest>();
  for (const pr of world.pullRequests) if (!pr.merged) open.set(pr.number, pr);
  const closed = new Map<number, PullRequest>();
  for (const pr of world.closedPullRequests ?? []) closed.set(pr.number, pr);
  // A merged rung can be reported either way for a pulse or two — merged and
  // still in the open list, or moved to the closed one — so both readings count.
  // And after that, neither does: the durable record is the only thing left that
  // remembers, which is why it is asked first.
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
    // A rung that is neither open nor merged left the chain some other way —
    // closed by hand, or aged out of a world the provider no longer reports. The
    // intent cannot finish, and saying "landed" about a PR nothing observed
    // merging would be the one lie this record must never tell. Note this arm is
    // reached only once the durable record has been asked as well: the window
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
 * The intent covering a chain the cockpit is drawing, matched by **rung overlap
 * and not by ref**.
 *
 * The ref would be the obvious key and it is the wrong one: `stack:<bottom PR>`
 * renames itself the instant the bottom rung merges, so a match on it would lose
 * the intent at the first success — exactly when the operator most needs to see
 * "landing 1 of 3".
 *
 * Overlap alone was unambiguous only while a PR belonged to one chain, which a
 * **fork** breaks: two paths off one bottom share every rung beneath the split, so
 * an intent over one path overlaps the other and the sibling would draw a landing
 * that does not authorize it. `openPrNumbers` closes that — an intent covering a
 * rung that is *still open* and not in this chain is some other chain's. It has to
 * be open: a chain shrinks as its rungs merge, and rejecting on a merged rung
 * would lose the intent at the first success all over again.
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
    // The durable record first, for `settleLandings`' reason: read off the window
    // alone, "landing 1 of 3" counts back *down* to 0 of 3 as rungs age out.
    if (world.merged?.has(n) === true) return true;
    const pr = byNumber.get(n);
    return pr !== undefined && (pr.merged === true || pr.state === 'merged');
  }).length;
}
