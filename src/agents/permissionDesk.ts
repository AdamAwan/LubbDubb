import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { Agent, Task } from '../types.js';

/**
 * The verdict Claude Code's `--permission-prompt-tool` expects back, verbatim.
 * `allow` may rewrite the tool input (we pass it through unchanged); `deny`
 * carries a message the agent reads. This is the bare shape the `request_permission`
 * tool returns — never wrapped in the `_status` envelope other tools carry, which
 * Claude's permission parser would not understand.
 */
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

/**
 * The permission backstop (issue #130 phase B).
 *
 * Phase A's allow-list pre-approves the mechanical commands a coding agent must
 * run unattended. Anything it doesn't cover used to hang: a headless agent has no
 * human at the permission prompt, and the escalation it printed ("grant Bash
 * permissions in harness settings") was unanswerable, because the gate is a launch
 * flag, not a conversation. This closes that: Claude Code calls `request_permission`
 * (via `--permission-prompt-tool`) for the un-allowlisted call, which lands here.
 *
 * **Why this and not a `Proposal`.** A `Proposal` is a *durable* verdict re-read
 * every pulse against persistent world state (settle windows, world-signal expiry).
 * A permission request is the opposite — ephemeral and single-shot: the agent is
 * blocked on an open socket *right now*, and if the harness restarts the blocked
 * call dies with the process. So this is a small in-memory registry, not a proposal
 * kind. It reuses the *escalation inbox* purely as the visible "Needs you" surface;
 * the decision resolves a blocked Promise, it does not persist a verdict.
 *
 * **Why it doesn't type into the agent.** The ordinary escalation answer routes the
 * reply into the agent's stdin (`agents.respond`). Here the agent is blocked inside
 * a tool call, not parked at a prompt — the "answer" is the tool's *return value*.
 * So {@link decide} settles the inbox item through `EscalationInbox.settleResolved`,
 * which never touches the session, and resolves the Promise the handler is awaiting.
 */
export class PermissionDesk {
  /** escalationId -> the blocked tool call awaiting a verdict. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly escalations: EscalationInbox) {}

  /**
   * File a permission request and block until the operator decides. Creates the
   * "Needs you" escalation synchronously (so it is visible the moment the agent
   * blocks) and returns a Promise that resolves when {@link decide} or
   * {@link denyAll} settles it.
   */
  request(agent: Agent, task: Task, toolName: string, input: Record<string, unknown>): Promise<PermissionVerdict> {
    const summary = summarisePermission(toolName, input);
    const esc = this.escalations.create({
      type: 'approve_change',
      prompt: `Agent wants to run ${summary}`,
      context: {
        taskTitle: task.title,
        originRef: task.originRef ?? null,
        permission: { toolName, summary },
        // Rendered as one-click answers by the cockpit's EscalationCard.
        options: ['Allow', 'Deny'],
      },
      agentId: agent.id,
      taskId: task.id,
    });
    return new Promise<PermissionVerdict>((resolve) => {
      this.pending.set(esc.id, { agentId: agent.id, input, resolve });
    });
  }

  /**
   * Apply the operator's decision: resolve the blocked call with allow/deny and
   * settle the inbox item. Returns false if the escalation names no pending
   * request (already decided, or the agent died first) — the caller 409s.
   */
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
    // Settle without typing into the agent — it is blocked in a tool call, not at
    // a prompt. Best-effort: a racing terminal transition may have settled it.
    try {
      this.escalations.settleResolved(escalationId, allow ? 'Allowed' : `Denied${trimmed ? `: ${trimmed}` : ''}`);
    } catch {
      /* already settled */
    }
    return true;
  }

  /**
   * Resolve every request an agent is blocked on as a denial — called when the
   * agent leaves the fleet (kill / crash / shutdown) so a dead agent never leaves
   * Claude blocked. Only the Promise is settled here; the open escalation is
   * dismissed by the existing terminal-state cascade in `system.ts`.
   */
  denyAll(agentId: string, reason: string): void {
    for (const [escId, p] of [...this.pending.entries()]) {
      if (p.agentId !== agentId) continue;
      this.pending.delete(escId);
      p.resolve({ behavior: 'deny', message: reason });
    }
  }
}

/** How many characters of a rendered command to keep on the card before eliding. */
const MAX_SUMMARY = 200;

/**
 * A one-line, human-readable rendering of a permission request. Prefers the Bash
 * `command` (the overwhelmingly common case), else names the tool and a compact
 * view of its input. Pure. Bounded so a pathological input can't bloat the
 * escalation payload the whole cockpit refetches.
 */
function summarisePermission(toolName: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const body = command || compactInput(input);
  const rendered = body ? `${toolName}: ${body}` : toolName;
  return rendered.length > MAX_SUMMARY ? `${rendered.slice(0, MAX_SUMMARY - 1)}…` : rendered;
}

/** A compact single-line JSON of the tool input, or '' when there's nothing useful. */
function compactInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return keys.join(', ');
  }
}
