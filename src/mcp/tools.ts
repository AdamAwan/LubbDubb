import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Agent, AgentAsk, Finding, FindingInput, Task } from '../types.js';
import { validatePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument, overriddenSingleMessage } from '../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../plans/planning.js';
import { liveParts } from '../plans/parts.js';
import { FINDING_KIND_HELP, FINDING_KINDS, validateFinding } from './findings.js';
import { MCP_TOOL_NAMES } from './names.js';
import { type McpTool, toolError, toolJson, type ToolCallResult } from './protocol.js';
import { parseWorldRef, readWorldItem, WORLD_READ_KINDS } from './worldRead.js';

/**
 * What the tool layer needs from the fleet. Narrow on purpose, and both methods
 * are here for the same reason: each has a fleet-side transition or event that
 * must not be bypassed. `ask` goes through the *same* park the WAITING sentinel
 * drives; `recordFinding` persists and then emits, so the cockpit hears about a
 * finding the moment it is filed rather than on the next pulse.
 */
export interface AgentToolTarget {
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string };
  recordFinding(agentId: string, input: FindingInput): { ok: true; finding: Finding } | { ok: false; error: string };
}

export interface McpToolDeps {
  store: Store;
  agents: AgentToolTarget;
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
    {
      name: MCP_TOOL_NAMES[2],
      description:
        "Read the harness's own view of a pull request, issue or story — CI status, review " +
        'comments, merge state, labels, an issue body and its plan graph. Prefer this over ' +
        'shelling out to `gh`/`az`: it is the same snapshot the dispatcher decided on (so it ' +
        'explains why you were dispatched), it works whichever provider is configured, and it ' +
        'costs no API call. Pass the ref you were given in `_status.origin`, or any other item ' +
        "the harness is tracking. Omit `ref` to read your own origin's item.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [...WORLD_READ_KINDS],
            description: 'Which kind of world item to read.',
          },
          ref: {
            type: 'string',
            description:
              'The item, in the ref shape used everywhere else: "pr:42", "issue:12", "story:abc". ' +
              'An origin ref with a suffix ("pr:42:ci", "issue:12:part:schema") names the same item, ' +
              'and a bare number works too. Defaults to your own origin.',
          },
        },
        required: ['kind'],
      },
      handler: (args) => {
        const read = readWorld(deps.store, task, args);
        return read.ok ? ok(read.payload) : toolError(read.error);
      },
    },
    {
      name: MCP_TOOL_NAMES[3],
      description:
        'File something you noticed that is NOT your task — a duplicate, work blocked on something ' +
        'outside your reach, an unrelated problem you ran into. It lands in the harness and shows up ' +
        'in the cockpit for an operator, instead of being buried in a PR comment nobody reads. ' +
        'It does NOT create work or dispatch anyone: an operator decides whether it becomes a job. ' +
        'So report it and carry on with your own task — do not wait, and do not go fix it yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [...FINDING_KINDS],
            description: FINDING_KINDS.map((k) => `${k}: ${FINDING_KIND_HELP[k]}`).join('. '),
          },
          summary: {
            type: 'string',
            description:
              'One or two sentences an operator can act on without asking you: what it is, where, ' +
              'and why it matters. Include the evidence — you are the only one who saw it.',
          },
          ref: {
            type: 'string',
            description:
              'The item this is about, if there is one: "issue:41", "pr:42", "story:abc". For a ' +
              'duplicate, the item you believe it duplicates. Omit it when the finding is about ' +
              'something the harness does not track.',
          },
        },
        required: ['kind', 'summary'],
      },
      handler: (args) => {
        // Validated at the boundary, with the reason handed back — the whole point
        // of a tool over a PR comment is that a malformed report is a fixable error
        // in this turn rather than a paragraph nobody parses.
        const parsed = validateFinding(args);
        if (!parsed.ok) return toolError(`Finding rejected: ${parsed.error}`);
        // Attribution is the credential's, never an argument's. `world_read` could
        // relax the no-cross-origin rule because a read forges nothing and mutates
        // nothing; this is a *write* that puts words in an agent's mouth in front of
        // an operator. An agent that could name the reporter could file a finding as
        // another agent — and a finding is read as testimony about work its author
        // actually did, so a forged one is worse than no channel at all.
        const result = deps.agents.recordFinding(agent.id, parsed.input);
        if (!result.ok) return toolError(result.error);
        return ok({
          recorded: true,
          finding: {
            id: result.finding.id,
            kind: result.finding.kind,
            ref: result.finding.ref,
            status: result.finding.status,
          },
          // Said again in the response, not only in the description: an agent that
          // believes reporting a bug scheduled its fix will stop watching for it.
          note: 'Filed for an operator. It queues no work by itself — keep going with your own task.',
        });
      },
    },
  ];
}

/**
 * `world_read`'s body: resolve the target, read it out of the last world snapshot,
 * and fold in the plan graph for an issue.
 *
 * **Scope: this is a general read, not one confined to the caller's origin.** It is
 * the first tool where the "no cross-origin argument" property doesn't hold by
 * construction, so the choice is explicit:
 *
 * - The dispatcher's own reasoning is cross-item, so an agent's is too. A stacked
 *   PR's red CI belongs to the PR *underneath* it (`inheritedCiFailure`); a part's
 *   context is its siblings; a PR-fix agent wants the issue it resolves. Confining
 *   the read to one origin would send an agent that was just told "CI failing on
 *   base PR #7" straight back to `gh` to look at #7 — the exact gap this closes.
 * - What structural identity protects is *writes*. `plan_submit` mutates the plan
 *   graph and `escalate` parks an agent, so both must be unable to name another
 *   agent's work. A read forges nothing and mutates nothing.
 * - The data is already public at a weaker boundary: the cockpit serves this same
 *   snapshot unauthenticated over HTTP, while this path needs a 0600 bearer token.
 *
 * The part of the property that *is* kept: an agent can only name items the harness
 * is already tracking, in the harness's own vocabulary. There is no query, no
 * provider passthrough, and no path or URL argument — so this cannot be used to
 * reach a different repository, a different project, or anything the harness does
 * not already hold.
 */
function readWorld(
  store: Store,
  task: Task,
  args: Record<string, unknown>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  // The store's baseline *is* the harness's view: `Harness.recordWorldChanges`
  // persists each pulse's snapshot as it diffs it. Reading it here rather than
  // calling the connector is the point of the tool — no provider fan-out per
  // agent, no provider-shaped payload, and the agent sees the same world the
  // dispatch decision was made against.
  const world = store.getWorldBaseline();
  if (!world) {
    return {
      ok: false,
      error: 'The harness has not completed a cycle yet, so it has no world snapshot to read. Retry shortly.',
    };
  }
  // Defaulting to the caller's own origin keeps the common case argument-free —
  // "how is my PR doing" — and reuses exactly the ref the `_status` envelope hands back.
  const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref : (task.originRef ?? '');
  const target = parseWorldRef(args.kind, ref);
  if (!target.ok) return { ok: false, error: target.error };
  const found = readWorldItem(world, target.target);
  if (!found.ok) return { ok: false, error: found.error };

  const item = { ...found.item };
  if (target.target.kind === 'issue') {
    // The plan graph lives only in the store, so it isn't in the snapshot — but an
    // issue's decomposition is most of what an agent working one of its parts needs.
    const plan = store.getPlanByOrigin(target.target.canonical);
    if (plan) {
      item.plan = {
        status: plan.status,
        reason: plan.reason,
        parts: liveParts(store.listPlanParts(plan.id)).map((p) => ({
          slug: p.slug,
          title: p.title,
          scope: p.scope,
          dependsOn: p.dependsOn,
          status: p.status,
          branch: p.branch,
          prNumber: p.prNumber,
        })),
      };
    }
  }
  // The snapshot's age, because it is a pulse-old reading rather than a live fetch
  // and an agent deciding whether to wait needs to know which.
  return { ok: true, payload: { observedAt: world.takenAt, item } };
}
