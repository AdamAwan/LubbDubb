import { issueOriginNumber } from '../issueOrigins.js';
import type { WorkNode } from '../types.js';
import { prNumberOf } from '../primitives.js';

// → docs/spec/41-repo-lessons.md#a-remedys-goal

/** Each pull request in the work graph mapped to the `issue:<n>` root its `parentRef` chain reaches. */
export function prGoalIndex(nodes: readonly WorkNode[]): Map<number, string> {
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const out = new Map<number, string>();
  for (const node of nodes) {
    if (node.kind !== 'pr') continue;
    const number = prNumberOf(node.ref);
    if (number === null) continue;
    let current: WorkNode | undefined = node;
    for (let hops = 0; hops < nodes.length && current !== undefined; hops += 1) {
      if (issueOriginNumber('root', current.ref) !== null) {
        out.set(number, current.ref);
        break;
      }
      current = current.parentRef === null ? undefined : byRef.get(current.parentRef);
    }
  }
  return out;
}
