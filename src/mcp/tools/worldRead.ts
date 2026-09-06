import type { Store } from '../../store/store.js';
import type { Task } from '../../types.js';
import { liveParts } from '../../plans/parts.js';
import { toolError } from '../protocol.js';
import { parseWorldRef, readWorldItem, WORLD_READ_KINDS } from '../worldRead.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

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

function readWorld(
  store: Store,
  task: Task,
  args: Record<string, unknown>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const world = store.getWorldBaseline();
  if (!world) {
    return {
      ok: false,
      error: 'The harness has not completed a cycle yet, so it has no world snapshot to read. Retry shortly.',
    };
  }
  const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref : (task.originRef ?? '');
  const target = parseWorldRef(args.kind, ref);
  if (!target.ok) return { ok: false, error: target.error };
  const found = readWorldItem(world, target.target);
  if (!found.ok) return { ok: false, error: found.error };

  const item = { ...found.item };
  if (target.target.kind === 'issue') {
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
  return { ok: true, payload: { observedAt: world.takenAt, item } };
}
