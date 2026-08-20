import type { AgentFile, PlanPart, TaskSummary } from '../types.js';
import { partOrigin } from './parts.js';

/**
 * Where a part's agents wrote outside the paths the plan said the part owned.
 *
 * The plan has always carried the claim — `scope` in prose, and now `touches` as
 * paths — and nothing has ever compared it to anything. That made a decomposition
 * a promise rather than a check: two parts running in parallel could be declared
 * to own disjoint directories and quietly both edit the same file, and the only
 * surface that would ever say so was `detectFileOverlaps`, which needs them to be
 * *concurrent* to notice. This needs nothing but a merged part and its writes.
 *
 * **It reports, and blocks nothing.** Writing outside a declared scope is often
 * right — a change genuinely needs a type moved, an import updated, a test added
 * somewhere the planner did not foresee. What is wrong is doing it *invisibly*,
 * and the whole cost of fixing that is one line under the part on the sheet.
 *
 * Pure, over rows the store already holds: `agent_files` is written by the
 * file-events hook for every path any agent writes, which is the same source
 * `src/fileOverlap.ts` reads.
 */

/** One part's writes that fell outside its declaration. */
interface ScopeDrift {
  partId: string;
  /** Distinct paths written outside `touches`, in the order they were first written. */
  paths: string[];
}

/**
 * Drift for every part that declared a scope and has an agent behind it.
 *
 * Parts with no `touches` are absent rather than empty: a part that declared
 * nothing has not been contradicted by anything, and a `0 outside scope` badge on
 * one would read as a check that had passed.
 */
export function planScopeDrift(
  issueNumber: number,
  parts: PlanPart[],
  tasks: TaskSummary[],
  files: AgentFile[],
): ScopeDrift[] {
  const filesByAgent = new Map<string, AgentFile[]>();
  for (const file of files) {
    const list = filesByAgent.get(file.agentId);
    if (list) list.push(file);
    else filesByAgent.set(file.agentId, [file]);
  }
  // By origin rather than by `part.taskId`, which holds only the *last* dispatch:
  // a part that stalled and was re-dispatched wrote from two agents, and the
  // earlier one's writes are on the branch just as much as the later one's.
  const agentsByOrigin = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.originRef === null || task.agentId === null) continue;
    const list = agentsByOrigin.get(task.originRef);
    if (list) list.push(task.agentId);
    else agentsByOrigin.set(task.originRef, [task.agentId]);
  }

  const out: ScopeDrift[] = [];
  for (const part of parts) {
    if (part.touches.length === 0) continue;
    const agents = agentsByOrigin.get(partOrigin(issueNumber, part.slug)) ?? [];
    const written = agents.flatMap((id) => filesByAgent.get(id) ?? []);
    const paths: string[] = [];
    for (const file of written) {
      const path = normalise(file.path);
      if (path === '' || pathIsInside(path, part.touches)) continue;
      if (!paths.includes(path)) paths.push(path);
    }
    if (paths.length > 0) out.push({ partId: part.id, paths });
  }
  return out;
}

/**
 * Is a written path covered by any declared entry?
 *
 * A declaration is read as a **prefix**: `src/store/` covers `src/store/plans.ts`,
 * and `src/system.ts` covers itself. Prefix rather than glob because that is how a
 * planner writes them — the prompt asks for "a directory or a file per entry" —
 * and a glob dialect would be a syntax the planner has to get right for the check
 * to mean anything.
 *
 * The trailing-separator test is what stops `src/store` covering `src/storefront`.
 */
function pathIsInside(path: string, touches: string[]): boolean {
  return touches.some((raw) => {
    const declared = normalise(raw).replace(/\/+$/, '');
    if (declared === '') return true; // a bare "/" or "." — the planner declared the repository
    return path === declared || path.startsWith(`${declared}/`);
  });
}

/** Repository-relative, forward slashes, no leading `./` — both sides are agent-authored. */
function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}
