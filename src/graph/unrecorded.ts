import type { Job, WorkItemFiling, WorkItemFilingStatus, WorkNode } from '../types.js';

// → docs/spec/14-persistence.md#the-work-graph

export interface UnrecordedWork {
  ref: string;
  title: string;
  prCount: number;
  firstSeenAt: string;
  filing: WorkItemFilingStatus | null;
  ignored: boolean;
}

export function unrecordedWork(
  nodes: WorkNode[],
  jobs: Job[],
  filings: WorkItemFiling[],
  ignoredRefs: string[] = [],
): UnrecordedWork[] {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const filingFor = new Map(filings.map((f) => [f.targetRef, f]));
  const ignored = new Set(ignoredRefs);

  const prsUnder = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== 'pr' || n.parentRef === null) continue;
    prsUnder.set(n.parentRef, (prsUnder.get(n.parentRef) ?? 0) + 1);
  }

  const out: UnrecordedWork[] = [];
  for (const n of nodes) {
    if (n.kind !== 'job' || n.parentRef !== null) continue;
    const job = jobById.get(n.ref.slice('job:'.length));
    if (!job || job.kind !== 'code' || job.status !== 'dispatched') continue;
    out.push({
      ref: n.ref,
      title: n.title,
      prCount: prsUnder.get(n.ref) ?? 0,
      firstSeenAt: n.firstSeenAt,
      filing: filingFor.get(n.ref)?.status ?? null,
      ignored: ignored.has(n.ref),
    });
  }
  return out;
}

const MAX_TITLE = 80;

export function workItemTicketFields(
  node: WorkNode,
  subtree: WorkNode[],
): { title: string; vars: Record<string, string> } {
  const produced = subtree
    .filter((n) => n.ref !== node.ref)
    .map((n) => `- ${n.ref} (${n.kind}) — ${n.title} [${n.status}${n.provenance ? `, ${n.provenance}` : ''}]`);
  return {
    title: node.title.slice(0, MAX_TITLE),
    vars: {
      ref: node.ref,
      workTitle: node.title,
      produced: produced.length ? produced.join('\n') : 'Nothing the harness could observe — no pull request opened.',
    },
  };
}
