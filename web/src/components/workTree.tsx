import type { JSX } from 'react';
import type { WorkNodeView } from '../types.js';
import { Ref } from './refs.js';
import { relTime } from './util.js';
import { Tag } from './tag.js';

/**
 * One node of the durable work graph, and the walk that indents it.
 *
 * Here rather than in either panel because there are two surfaces onto the same
 * subtree now — [the record panel](./RecordPanel.js), which draws a root the operator
 * expanded, and [the record](./WorkRecord.js) on a goal's page, which draws that
 * goal's own. A row copied into the second would drift from the first exactly
 * where it matters least visibly: `inferred` is a chip that says the harness never
 * watched the merge it is claiming, and a surface that quietly stopped drawing it
 * reports a stronger fact than it holds.
 *
 * Both callers wrap this in `RefLinksExtended` with the **route's** `refUrls`
 * rather than the snapshot's. That is not a detail: the graph's whole reason to
 * exist is remembering a pull request the world forgot hours ago, so the shell's
 * map — assembled from the world — has no entry for most of what these rows name.
 */
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

/**
 * How deep a node sits, by walking `parentRef` within the subtree — so the indent
 * needs no ordering contract from the server, and a node whose parent is outside
 * the fetched subtree simply sits at the top rather than disappearing.
 *
 * That last arm is what lets the record draw a goal's subtree with the goal itself
 * dropped: every child of the root is orphaned by the filter and lands flush left,
 * which is the shape a reader wants when the root is the page they are already on.
 */
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

/**
 * The refs that name *themselves*, and so are the only ones a row draws.
 *
 * `refLabel` shortens every ref in a family to its number, so `issue:395:plan` and
 * `issue:395:part:api` both read `#395` — the number of their **ancestor**, which
 * on a record listing that ancestor's whole subtree is drawn three or four times
 * over, each one a link back to the page the reader is standing on. A dead end
 * wearing the shape of a destination is worse than no ref at all, which is the
 * whole argument `refs.tsx` is built on.
 *
 * So a sub-origin draws none: its identity is its title and its indent, both of
 * which are already correct, and the number it would show belongs to the row
 * above it. Only the canonical forms — a goal and a pull request — name a thing
 * this row *is*.
 */
const NAMES_ITSELF = /^(?:issue|pr):\d+$/;

/** What each kind is, at a glance. */
const MARK: Record<string, string> = {
  issue: '◆',
  plan: '⌗',
  part: '▪',
  pr: '⇡',
  concern: '!',
  job: '▸',
  assess: '?',
};
