import type { Store } from '../../store/store.js';
import type { Task } from '../../types.js';
import { liveParts } from '../../plans/parts.js';
import { toolError } from '../protocol.js';
import { parseWorldRef, readWorldItem, WORLD_READ_KINDS } from '../worldRead.js';
import type { ToolFactory } from './context.js';

export const worldRead: ToolFactory = ({ deps, task, ok }) => ({
  description:
    "Read the harness's own view of a pull request or issue — CI status, review " +
    'comments, merge state, labels, an issue body and its plan graph. Prefer this over ' +
    'shelling out to `gh`/`az`: it is the same snapshot the dispatcher decided on (so it ' +
    'explains why you were dispatched), it works whichever provider is configured, and it ' +
    'costs no API call. Pass the ref you were given in `_status.origin`, or any other item ' +
    "the harness is tracking. Omit `ref` to read your own origin's item.",
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...WORLD_READ_KINDS],
        description: 'Which kind of world item to read.',
      },
      ref: {
        type: 'string',
        description:
          'The item, in the ref shape used everywhere else: "pr:42", "issue:12". ' +
          'An origin ref with a suffix ("pr:42:ci", "issue:12:part:schema") names the same item, ' +
          'and a bare number works too. Defaults to your own origin.',
      },
    },
    required: ['kind'],
  },
  handler: (args) => {
    const read = readWorld(deps.store, task, args);
    return read.ok ? ok(read.payload) : toolError(read.error);
  },
});

/**
 * `world_read`'s body: resolve the target, read it out of the last world snapshot,
 * and fold in the plan graph for an issue.
 *
 * **Scope: this is a general read, not one confined to the caller's origin.** It is
 * the first tool where the "no cross-origin argument" property doesn't hold by
 * construction, so the choice is explicit:
 *
 * - The dispatcher's own reasoning is cross-item, so an agent's is too. A stacked
 *   PR's red CI belongs to the PR *underneath* it (`inheritedCiFailure`); a part's
 *   context is its siblings; a PR-fix agent wants the issue it resolves. Confining
 *   the read to one origin would send an agent that was just told "CI failing on
 *   base PR #7" straight back to `gh` to look at #7 — the exact gap this closes.
 * - What structural identity protects is *writes*. `plan_submit` mutates the plan
 *   graph and `escalate` parks an agent, so both must be unable to name another
 *   agent's work. A read forges nothing and mutates nothing.
 * - The data is already public at a weaker boundary: the cockpit serves this same
 *   snapshot unauthenticated over HTTP, while this path needs a 0600 bearer token.
 *
 * The part of the property that *is* kept: an agent can only name items the harness
 * is already tracking, in the harness's own vocabulary. There is no query, no
 * provider passthrough, and no path or URL argument — so this cannot be used to
 * reach a different repository, a different project, or anything the harness does
 * not already hold.
 */
function readWorld(
  store: Store,
  task: Task,
  args: Record<string, unknown>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  // The store's baseline *is* the harness's view: `Harness.recordWorldChanges`
  // persists each pulse's snapshot as it diffs it. Reading it here rather than
  // calling the connector is the point of the tool — no provider fan-out per
  // agent, no provider-shaped payload, and the agent sees the same world the
  // dispatch decision was made against.
  const world = store.getWorldBaseline();
  if (!world) {
    return {
      ok: false,
      error: 'The harness has not completed a cycle yet, so it has no world snapshot to read. Retry shortly.',
    };
  }
  // Defaulting to the caller's own origin keeps the common case argument-free —
  // "how is my PR doing" — and reuses exactly the ref the `_status` envelope hands back.
  const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref : (task.originRef ?? '');
  const target = parseWorldRef(args.kind, ref);
  if (!target.ok) return { ok: false, error: target.error };
  const found = readWorldItem(world, target.target);
  if (!found.ok) return { ok: false, error: found.error };

  const item = { ...found.item };
  if (target.target.kind === 'issue') {
    // The plan graph lives only in the store, so it isn't in the snapshot — but an
    // issue's decomposition is most of what an agent working one of its parts needs.
    const plan = store.getPlanByOrigin(target.target.canonical);
    if (plan) {
      item.plan = {
        status: plan.status,
        reason: plan.reason,
        parts: liveParts(store.listPlanParts(plan.id)).map((p) => ({
          slug: p.slug,
          title: p.title,
          scope: p.scope,
          dependsOn: p.dependsOn,
          status: p.status,
          branch: p.branch,
          prNumber: p.prNumber,
        })),
      };
    }
    // The durable record of what was actually done for this issue — stage 1's
    // work graph. This is what the world cannot supply: `closedPullRequests` is
    // bounded by `closedPrWindowMs` (6h), so a PR that delivered the issue last
    // week is simply absent from the snapshot, and the edge to it is here or
    // nowhere. `provenance` rides along because the assessor must weigh "the
    // harness watched this merge" differently from "it left the open list and
    // the merge was assumed" — stage 1 recorded that distinction for this reader.
    //
    // Reading it here rather than in the pure `worldRead.ts` keeps that file's
    // line: it maps a snapshot, and the store lookups live in the tool layer.
    // Nothing about stage 1's structural property changes — that is about no
    // *rule* consulting the graph, and an agent reading its own history is the
    // consumer it was built for.
    const work = store.listWorkSubtree(target.target.canonical);
    if (work.length > 0) {
      item.work = work.map((n) => ({
        ref: n.ref,
        kind: n.kind,
        parentRef: n.parentRef,
        baseRef: n.baseRef,
        title: n.title,
        status: n.status,
        terminal: n.terminal,
        provenance: n.provenance,
      }));
    }
  }
  // The snapshot's age, because it is a pulse-old reading rather than a live fetch
  // and an agent deciding whether to wait needs to know which.
  return { ok: true, payload: { observedAt: world.takenAt, item } };
}
