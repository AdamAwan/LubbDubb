import type { PullRequest, WorldSnapshot } from '../types.js';
import { basePrOf, inheritedCiFailure, prHealth, prState } from '../pr/prHealth.js';

// → docs/spec/11-mcp-tools.md

export const WORLD_READ_KINDS = ['pr', 'issue'] as const;

type WorldReadKind = (typeof WORLD_READ_KINDS)[number];

interface WorldRef {
  kind: WorldReadKind;
  number: number | null;
  canonical: string;
}

const MAX_SUGGESTED = 20;

function isKind(value: string): value is WorldReadKind {
  return (WORLD_READ_KINDS as readonly string[]).includes(value);
}

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

  const head = rest.split(':')[0]?.replace(/^#/, '') ?? '';
  if (!/^\d+$/.test(head)) {
    return { ok: false, error: `ref "${raw}" does not contain a ${k} number (expected e.g. ${k}:42 or 42).` };
  }
  const number = Number(head);
  return { ok: true, target: { kind: k, number, canonical: `${k}:${number}` } };
}

export function readWorldItem(
  world: WorldSnapshot,
  target: WorldRef,
): { ok: true; item: Record<string, unknown> } | { ok: false; error: string } {
  switch (target.kind) {
    case 'pr': {
      const open = world.pullRequests.find((pr) => pr.number === target.number);
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
          linkedPrNumber: issue.linkedPrNumber,
          url: issue.url ?? null,
        },
      };
    }
  }
}

function prView(pr: PullRequest, world: WorldSnapshot): Record<string, unknown> {
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
    ciChecks: pr.ciChecks ?? [],
    approved: pr.approved ?? false,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeableState ?? 'unknown',
    labels: pr.labels ?? [],
    url: pr.url ?? null,
    health: prHealth(pr, openPrs),
    basePr: base ? { number: base.number, branch: base.branch, ciStatus: base.ciStatus } : null,
    ciFailingOnBasePr: inherited?.number ?? null,
    unresolvedComments: pr.unresolvedComments.map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      handled: c.handled,
      replies: (c.replies ?? []).map((r) => ({ id: r.id, author: r.author, body: r.body, ours: r.ours })),
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
