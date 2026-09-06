import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { Agent, Task } from '../types.js';

// → docs/spec/10-agent-runtimes.md

interface PermissionVerdict {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

interface Pending {
  agentId: string;
  input: Record<string, unknown>;
  resolve: (verdict: PermissionVerdict) => void;
}

export class PermissionDesk {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly escalations: EscalationInbox) {}

  request(agent: Agent, task: Task, toolName: string, input: Record<string, unknown>): Promise<PermissionVerdict> {
    const summary = summarisePermission(toolName, input);
    const esc = this.escalations.create({
      type: 'approve_change',
      prompt: `Agent wants to run ${summary}`,
      context: {
        taskTitle: task.title,
        originRef: task.originRef ?? null,
        permission: { toolName, summary },
        options: ['Allow', 'Deny'],
      },
      agentId: agent.id,
      taskId: task.id,
    });
    return new Promise<PermissionVerdict>((resolve) => {
      this.pending.set(esc.id, { agentId: agent.id, input, resolve });
    });
  }

  decide(escalationId: string, allow: boolean, note?: string): boolean {
    const p = this.pending.get(escalationId);
    if (!p) return false;
    this.pending.delete(escalationId);
    const trimmed = note?.trim();
    p.resolve(
      allow
        ? { behavior: 'allow', updatedInput: p.input }
        : { behavior: 'deny', message: trimmed || 'The operator denied this command.' },
    );
    try {
      this.escalations.settleResolved(escalationId, allow ? 'Allowed' : `Denied${trimmed ? `: ${trimmed}` : ''}`);
    } catch {
      /* already settled */
    }
    return true;
  }

  denyAll(agentId: string, reason: string): void {
    for (const [escId, p] of [...this.pending.entries()]) {
      if (p.agentId !== agentId) continue;
      this.pending.delete(escId);
      p.resolve({ behavior: 'deny', message: reason });
    }
  }
}

const MAX_SUMMARY = 200;

function summarisePermission(toolName: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const body = command || compactInput(input);
  const rendered = body ? `${toolName}: ${body}` : toolName;
  return rendered.length > MAX_SUMMARY ? `${rendered.slice(0, MAX_SUMMARY - 1)}…` : rendered;
}

function compactInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return keys.join(', ');
  }
}
