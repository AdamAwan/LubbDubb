import type { AppState, OpenPullRequest, Stack, StackLandingView } from '../types.js';

/**
 * The rack's arrangement: which open pull requests are rungs of a chain, and
 * which stand alone.
 *
 * A fold rather than a second reading of the world. `state.stacks` is the
 * server's own lens (`buildStacks`) and `state.stackLandings` is its readiness
 * verdict per chain — walking `baseBranch` here would be a client-side second
 * opinion about what stacks on what, which is the drift the whole `wire.ts` rule
 * exists to stop.
 *
 * **Matched by ref, deliberately.** `Stack.ref` names the bottom rung and is
 * therefore unstable across a landing, which is exactly why the *server* joins an
 * operator's intent to a chain by rung overlap. That join has already happened by
 * the time the snapshot ships: `stackLandings[i]` is the verdict for the chain the
 * server derived under that ref on this same pulse, so a ref match here reads one
 * pulse's answer rather than re-deciding it.
 */
export interface RackChain {
  stack: Stack;
  /** The server's readiness and standing intent for this chain, quoted. */
  landing: StackLandingView | null;
  /** The rungs' pull requests, bottom-first — `Stack.rungs`' own order. */
  prs: OpenPullRequest[];
}

interface RackView {
  chains: RackChain[];
  /** Every open pull request no chain claims, in the server's order. */
  loose: OpenPullRequest[];
}

export function buildRack(state: AppState): RackView {
  const open = state.world.pullRequests;
  const byNumber = new Map(open.map((pr) => [pr.number, pr]));
  const landingOf = new Map(state.stackLandings.map((l) => [l.ref, l]));

  const chains: RackChain[] = [];
  const claimed = new Set<number>();
  for (const stack of state.stacks) {
    const prs = stack.rungs.flatMap((rung) => {
      const pr = byNumber.get(rung.prNumber);
      return pr ? [pr] : [];
    });
    // A chain the open list no longer holds whole is not drawn as one: a header
    // reading "stack of 3" over two rows claims a rung the operator cannot see,
    // and the missing one is precisely the case worth not misreporting.
    if (prs.length !== stack.rungs.length || prs.length < 2) continue;
    for (const pr of prs) claimed.add(pr.number);
    chains.push({ stack, landing: landingOf.get(stack.ref) ?? null, prs });
  }

  return { chains, loose: open.filter((pr) => !claimed.has(pr.number)) };
}
