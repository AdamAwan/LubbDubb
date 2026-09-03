/**
 * The `world_read` tool's reading of the harness's own world snapshot.
 *
 * Pure over a {@link WorldSnapshot}: the kind vocabulary, the accepted ref
 * shapes and the view a caller gets back are all testable with no transport, no
 * store and no provider. The tool layer adds only the store lookups that aren't
 * in the snapshot (an issue's plan graph) and the `_status` envelope.
 */

import type { PullRequest, WorldSnapshot } from '../types.js';
import { basePrOf, inheritedCiFailure, prHealth, prState } from '../prHealth.js';

/**
 * The kinds a read can name.
 *
 * Taken from what the dispatcher already models rather than invented: these are
 * exactly the lists a {@link WorldSnapshot} carries and the ref prefixes the rest
 * of the system already writes (`pr:42`, `issue:12`). A third vocabulary would be
 * a third thing to keep in step with the rules, and there is nothing for it to name.
 */
export const WORLD_READ_KINDS = ['pr', 'issue'] as const;

type WorldReadKind = (typeof WORLD_READ_KINDS)[number];

/** A parsed target: which of the snapshot's lists to look in, and which row. */
interface WorldRef {
  kind: WorldReadKind;
  /** PR/issue number. */
  number: number | null;
  /** The canonical form (`pr:42`), echoed back and used in error messages. */
  canonical: string;
}

/** How many refs a "no such item" message lists before it stops being helpful. */
const MAX_SUGGESTED = 20;

function isKind(value: string): value is WorldReadKind {
  return (WORLD_READ_KINDS as readonly string[]).includes(value);
}

/**
 * Resolve a `(kind, ref)` pair to a target row.
 *
 * `ref` is deliberately permissive about *suffixes*, because the most useful
 * thing an agent can pass is the origin ref it was handed in `_status.origin` —
 * and those carry a concern (`pr:42:ci`), a plan arm (`issue:12:plan`) or a part
 * slug (`issue:12:part:schema`) after the number. All of those name the same
 * world item, so all of them resolve to it. Bare `42` and `#42` work too.
 *
 * It is *not* permissive about the prefix disagreeing with `kind`: `kind: 'pr'`
 * with `ref: 'issue:12'` is a mistake worth reporting, not something to guess at.
 */
export function parseWorldRef(
  kind: unknown,
  ref: unknown,
): { ok: true; target: WorldRef } | { ok: false; error: string } {
  const k = typeof kind === 'string' ? kind.trim() : '';
  if (!isKind(k)) {
    return { ok: false, error: `kind must be one of ${WORLD_READ_KINDS.join(', ')} (got ${JSON.stringify(kind)}).` };
  }
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (!raw) return { ok: false, error: `world_read needs a ref, e.g. ${k}:42.` };

  let rest = raw;
  const prefixed = /^(pr|issue):(.*)$/.exec(raw);
  if (prefixed) {
    if (prefixed[1] !== k) {
      return { ok: false, error: `ref "${raw}" is a ${prefixed[1]} ref, but kind is "${k}". Pass one or the other.` };
    }
    rest = prefixed[2] ?? '';
  }

  // `pr:42:ci` / `issue:12:part:schema` — the number is the first segment; the
  // rest is the concern the origin ref carries, which names no different item.
  const head = rest.split(':')[0]?.replace(/^#/, '') ?? '';
  if (!/^\d+$/.test(head)) {
    return { ok: false, error: `ref "${raw}" does not contain a ${k} number (expected e.g. ${k}:42 or 42).` };
  }
  const number = Number(head);
  return { ok: true, target: { kind: k, number, canonical: `${k}:${number}` } };
}

/**
 * Read one item out of the snapshot, as the harness sees it.
 *
 * This is the harness's *own* view, not a re-fetch: the same rows the dispatcher
 * decided against on the last pulse, folded through the same pure predicates the
 * cockpit renders (`prHealth`, and the stack attribution beside it). So an agent
 * and an operator looking at one PR are looking at one set of facts, and neither
 * of them is looking at a provider-shaped payload.
 */
export function readWorldItem(
  world: WorldSnapshot,
  target: WorldRef,
): { ok: true; item: Record<string, unknown> } | { ok: false; error: string } {
  switch (target.kind) {
    case 'pr': {
      const open = world.pullRequests.find((pr) => pr.number === target.number);
      // A PR that has left the open set is still worth reading — "did the PR my
      // branch is stacked on actually merge, or was it abandoned?" is exactly the
      // question the closed-PR window exists to answer.
      const closed = open ?? (world.closedPullRequests ?? []).find((pr) => pr.number === target.number);
      if (!closed) return { ok: false, error: `no PR ${target.canonical}. ${knownPrs(world)}` };
      return { ok: true, item: prView(closed, world) };
    }
    case 'issue': {
      const issue = world.issues.find((i) => i.number === target.number);
      if (!issue) return { ok: false, error: `no issue ${target.canonical}. ${knownIssues(world)}` };
      return {
        ok: true,
        item: {
          kind: 'issue',
          ref: target.canonical,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          workItemState: issue.workItemState ?? null,
          labels: issue.labels,
          // The PR opened to resolve this issue, if one is. Sticky once set, so a
          // number here does not by itself mean that PR is still open.
          linkedPrNumber: issue.linkedPrNumber,
          url: issue.url ?? null,
        },
      };
    }
  }
}

/** One PR as the harness reads it, including the verdicts the cockpit shows. */
function prView(pr: PullRequest, world: WorldSnapshot): Record<string, unknown> {
  // The *unfiltered* open list: an unwatched PR is hidden from dispatch but is
  // still a real base, so attribution must see it — the same reason
  // `DispatchContext` carries `hiddenPrs` alongside the dispatch world.
  const openPrs = world.pullRequests;
  const base = basePrOf(pr, openPrs);
  const inherited = inheritedCiFailure(pr, openPrs);
  return {
    kind: 'pr',
    ref: `pr:${pr.number}`,
    number: pr.number,
    title: pr.title,
    branch: pr.branch,
    baseBranch: pr.baseBranch ?? null,
    state: prState(pr),
    closedAt: pr.closedAt ?? null,
    ciStatus: pr.ciStatus,
    /**
     * The individual checks behind `ciStatus`. An agent sent to fix CI otherwise
     * has to shell out to `gh` to find out *which* check went red — the exact
     * provider coupling this tool exists to remove.
     */
    ciChecks: pr.ciChecks ?? [],
    approved: pr.approved ?? false,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeableState ?? 'unknown',
    labels: pr.labels ?? [],
    url: pr.url ?? null,
    // The same verdict the cockpit renders, from the same function — an agent and
    // an operator should never be reading two different accounts of one PR.
    health: prHealth(pr, openPrs),
    /** The open PR this one is stacked on, when its base is another live branch. */
    basePr: base ? { number: base.number, branch: base.branch, ciStatus: base.ciStatus } : null,
    // Whose red CI this is. Non-null means the failure belongs to the PR below,
    // which is also why no agent was dispatched here to fix it.
    ciFailingOnBasePr: inherited?.number ?? null,
    unresolvedComments: pr.unresolvedComments.map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      handled: c.handled,
    })),
  };
}

function suggest(label: string, refs: string[]): string {
  if (refs.length === 0) return `The harness is tracking no ${label}.`;
  const shown = refs.slice(0, MAX_SUGGESTED);
  const more = refs.length > shown.length ? `, … (${refs.length} total)` : '';
  return `${label} the harness is tracking: ${shown.join(', ')}${more}.`;
}

function knownPrs(world: WorldSnapshot): string {
  const open = world.pullRequests.map((pr) => `#${pr.number}`);
  const closed = (world.closedPullRequests ?? []).map((pr) => `#${pr.number} (${prState(pr)})`);
  return suggest('PRs', [...open, ...closed]);
}

function knownIssues(world: WorldSnapshot): string {
  return suggest(
    'Issues',
    world.issues.map((i) => `#${i.number}`),
  );
}
