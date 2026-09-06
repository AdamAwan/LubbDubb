import type { JSX } from 'react';
import type { WorkNodeView } from '../types.js';
import { Ref } from './refs.js';
import { relTime } from './util.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function WorkRow({ node, nodes, now }: { node: WorkNodeView; nodes: WorkNodeView[]; now: number }): JSX.Element {
  return (
    <div className={`work-node ${node.kind}`} style={{ marginLeft: `${depth(node, nodes) * 14}px` }}>
      <span className="work-mark">{MARK[node.kind] ?? '·'}</span>
      <span className="work-title">{node.title}</span>
      <Tag tone={node.terminal ? 'green' : undefined}>{node.status}</Tag>
      {/* Absence-means-merged is a deliberate fallback everywhere in the harness,
          but a durable record has no business forgetting it *was* one. */}
      {node.provenance === 'inferred' && (
        <Tag tone="amber" title="No merge was ever observed — this PR simply left the world">
          inferred
        </Tag>
      )}
      {node.baseRef !== null && (
        <Tag title="Stacked on this PR — a cross-link, not what caused the work">
          on <Ref to={node.baseRef} />
        </Tag>
      )}
      <span className="cn-refs">{NAMES_ITSELF.test(node.ref) && <Ref to={node.ref} />}</span>
      <span className="muted work-seen" title={`First seen ${node.firstSeenAt}`}>
        {relTime(node.lastSeenAt, now)}
      </span>
    </div>
  );
}

function depth(node: WorkNodeView, nodes: WorkNodeView[]): number {
  let d = 0;
  let cur = node.parentRef;
  while (cur !== null && d < nodes.length) {
    const parent = nodes.find((n) => n.ref === cur);
    if (!parent) break;
    d += 1;
    cur = parent.parentRef;
  }
  return d;
}

const NAMES_ITSELF = /^(?:issue|pr):\d+$/;

const MARK: Record<string, string> = {
  issue: '◆',
  plan: '⌗',
  part: '▪',
  pr: '⇡',
  concern: '!',
  job: '▸',
  assess: '?',
};
