import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Agent, AgentAsk, Task } from '../types.js';
import { validatePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument, overriddenSingleMessage } from '../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../plans/planning.js';
import { MCP_TOOL_NAMES } from './names.js';
import { type McpTool, toolError, toolJson, type ToolCallResult } from './protocol.js';

/**
 * What the tool layer needs from the fleet. Narrow on purpose: the escalate tool
 * must go through the *same* park transition the WAITING sentinel drives, so it
 * asks {@link AgentManager} rather than writing to the store itself.
 */
export interface AgentAskTarget {
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string };
}

export interface McpToolDeps {
  store: Store;
  agents: AgentAskTarget;
  errors?: ErrorRecorder;
}

/**
 * The situational-awareness envelope every tool response carries. Cheap to
 * compute and it removes the need for a polling tool: an agent that calls
 * anything at all learns its origin, whether a human is currently parked on it,
 * and how its plan is progressing.
 */
interface StatusEnvelope {
  origin: string | null;
  task: { title: string; status: string };
  /** The open escalation this agent is parked on, if any. */
  awaitingHuman: { prompt: string } | null;
  /** Progress roll-up when the agent's issue has a plan; absent otherwise. */
  plan?: { status: string; parts: { slug: string; status: string }[] };
}

function statusEnvelope(store: Store, agent: Agent, task: Task): StatusEnvelope {
  const open = store.listOpenEscalations().find((e) => e.agentId === agent.id) ?? null;
  const env: StatusEnvelope = {
    origin: task.originRef,
    task: { title: task.title, status: task.status },
    awaitingHuman: open ? { prompt: open.prompt } : null,
  };
  const issue = planOriginIssue(task.originRef);
  const plan = issue === null ? null : store.getPlanByOrigin(issueOrigin(issue));
  if (plan) {
    env.plan = {
      status: plan.status,
      parts: store.listPlanParts(plan.id).map((p) => ({ slug: p.slug, status: p.status })),
    };
  }
  return env;
}

/** A resolved caller: the agent row the credential names, and its task. */
export interface McpIdentity {
  agent: Agent;
  task: Task;
}

/**
 * Build the tool set for one resolved caller.
 *
 * **Identity is structural, not argued.** No tool takes an agent, task, or issue
 * argument — every one of them is derived from the credential the call arrived
 * on. An agent working origin A therefore cannot address origin B by asking
 * nicely, which is the property the `plan.json` side channel had to approximate
 * with `planOriginIssue` fencing over a transport that carried no identity at all.
 */
export function buildTools(deps: McpToolDeps, identity: McpIdentity): McpTool[] {
  const { agent, task } = identity;
  const status = (): StatusEnvelope => statusEnvelope(deps.store, agent, task);
  const ok = (payload: Record<string, unknown>): ToolCallResult => toolJson({ ...payload, _status: status() });

  return [
    {
      name: MCP_TOOL_NAMES[0],
      description:
        'Submit your decomposition verdict for the issue you were dispatched to plan. ' +
        'Use verdict "single" when one pull request is the right shape, or "parts" with an ordered ' +
        'list of independently reviewable pieces. Validated immediately: on rejection you get the ' +
        'reason back and can fix and resubmit in this same turn. Replaces writing .lubbdubb/plan.json.',
      inputSchema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['single', 'parts'], description: 'One PR, or several.' },
          reason: { type: 'string', description: 'Why this shape — one or two sentences.' },
          parts: {
            type: 'array',
            description: 'Required when verdict is "parts"; ignored otherwise.',
            items: {
              type: 'object',
              properties: {
                slug: {
                  type: 'string',
                  description: 'Stable lowercase kebab-case id. Keep it identical across a replan.',
                },
                title: { type: 'string' },
                scope: { type: 'string', description: 'The files or areas this part owns.' },
                dependsOn: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'At most one slug: the part this one stacks on.',
                },
              },
              required: ['slug', 'title', 'scope'],
            },
          },
        },
        required: ['verdict', 'reason'],
      },
      handler: (args) => {
        const number = planOriginIssue(task.originRef);
        if (number === null) {
          return toolError(
            `plan_submit is only available to a planning agent. This task's origin is ` +
              `${task.originRef ?? '(none)'}, which is not a planning origin.`,
          );
        }
        // Same schema as the file path, so the two transports accept and reject
        // exactly the same documents — the difference is only that this one can
        // hand the reason back instead of burning an attempt to discover it.
        const parsed = validatePlanDocument({
          version: 1,
          verdict: args.verdict,
          reason: args.reason,
          parts: args.parts ?? [],
        });
        if (!parsed.ok) {
          // Nothing is written on a rejection: the caller retries against an
          // unchanged plan graph rather than a half-applied one.
          return toolError(`Plan rejected: ${parsed.error}`);
        }
        const result = ingestPlanDocument(deps.store, {
          doc: parsed.document,
          originRef: issueOrigin(number),
          title: task.originTitle ?? task.title,
        });
        if (result.overriddenSingle) {
          const message = overriddenSingleMessage(issueOrigin(number), result.overriddenSingle.liveParts);
          deps.errors?.record({ source: 'agent', message: `Agent ${agent.id}: ${message}` });
          // Told to the agent too, not just the operator — it asked for something
          // the world no longer allows and would otherwise assume it landed.
          return ok({ accepted: true, status: result.status, retired: result.retired, warning: message });
        }
        return ok({ accepted: true, status: result.status, retired: result.retired });
      },
    },
    {
      name: MCP_TOOL_NAMES[1],
      description:
        'Ask the human a question and park until they answer. Prefer this over printing the ' +
        'waiting sentinel: you can state what kind of decision you need and offer concrete ' +
        'options, which the cockpit renders as one-click answers. Returns immediately — the ' +
        "human's reply arrives as your next message.",
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One line: what you need decided.' },
          kind: {
            type: 'string',
            enum: ['approve', 'choose', 'clarify', 'review'],
            description: 'What sort of decision this is. Drives how the cockpit files it.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concrete answers the human can pick with one click.',
          },
          detail: { type: 'string', description: 'Optional background the human needs to decide.' },
        },
        required: ['question'],
      },
      handler: (args) => {
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) return toolError('escalate requires a non-empty question.');
        const options = Array.isArray(args.options)
          ? args.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim())
          : [];
        const result = deps.agents.ask(agent.id, {
          question,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          options: options.length > 0 ? options : undefined,
          detail: typeof args.detail === 'string' && args.detail.trim() ? args.detail.trim() : undefined,
        });
        if (!result.ok) return toolError(result.error);
        // `escalationId: null` means a whitelisted prompt was auto-answered, so the
        // agent was never actually parked. Say so rather than implying a human saw it.
        return ok({
          parked: result.escalationId !== null,
          escalationId: result.escalationId,
          note:
            result.escalationId === null
              ? 'Auto-answered by an operator whitelist rule; continue without waiting.'
              : 'Parked. Continue when the answer arrives as your next message.',
        });
      },
    },
  ];
}
