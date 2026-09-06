import type { AgentFile, PlanPart, TaskSummary } from '../types.js';
import { partOrigin } from './parts.js';

// → docs/spec/08-planning.md

interface ScopeDrift {
  partId: string;
  paths: string[];
}

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

function pathIsInside(path: string, touches: string[]): boolean {
  return touches.some((raw) => {
    const declared = normalise(raw).replace(/\/+$/, '');
    if (declared === '') return true;
    return path === declared || path.startsWith(`${declared}/`);
  });
}

function normalise(path: string): string {
  const trimmed = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
  return trimmed === '.' ? '' : trimmed;
}
