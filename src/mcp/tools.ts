import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { PermissionDesk } from '../agents/permissionDesk.js';
import type {
  Agent,
  AgentAsk,
  Finding,
  FindingInput,
  IssueConclusion,
  IssueConclusionVerdict,
  Task,
} from '../types.js';
import { validatePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument, overriddenSingleMessage } from '../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../plans/planning.js';
import { liveParts } from '../plans/parts.js';
import { CONCLUSION_VERDICT_HELP, CONCLUSION_VERDICTS, validateConclusion } from './conclusion.js';
import {
  ASSESSMENT_VERDICT_HELP,
  ASSESSMENT_VERDICTS,
  validateAssessment,
  type AssessmentVerdict,
} from './assessment.js';
import { FINDING_KIND_HELP, FINDING_KINDS, parseFindingRef, validateFinding } from './findings.js';
import { MCP_TOOL_NAMES } from './names.js';
import { normaliseNote } from './progress.js';
import { type McpTool, toolError, toolJson, type ToolCallResult } from './protocol.js';
import { parseWorldRef, readWorldItem, WORLD_READ_KINDS } from './worldRead.js';

/**
 * What the tool layer needs from the fleet. Narrow on purpose, and every method
 * is here for the same reason: each has a fleet-side transition or event that
 * must not be bypassed. `ask` goes through the *same* park the WAITING sentinel
 * drives; `recordFinding` and `recordProgress` persist and then emit, so the
 * cockpit hears the moment it happens rather than on the next pulse.
 */
export interface AgentToolTarget {
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string };
  recordFinding(agentId: string, input: FindingInput): { ok: true; finding: Finding } | { ok: false; error: string };
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string };
  linkTicket(agentId: string, ticketRef: string): { ok: true; finding: Finding } | { ok: false; error: string };
  recordConclusion(
    agentId: string,
    verdict: IssueConclusionVerdict,
    note: string,
  ): { ok: true; conclusion: IssueConclusion } | { ok: false; error: string };
  recordAssessment(
    agentId: string,
    verdict: AssessmentVerdict,
    summary: string,
  ): { ok: true; issueOrigin: string; verdict: AssessmentVerdict } | { ok: false; error: string };
}

interface McpToolDeps {
  store: Store;
  agents: AgentToolTarget;
  /** `planning.requireApproval` — see {@link ingestPlanDocument}. */
  requirePlanApproval?: boolean;
  /**
   * The permission backstop (issue #130 phase B). Present when
   * `mcp.permissionEscalation` is on; the `request_permission` tool blocks on it.
   * Absent, that tool reports the backstop is off rather than blocking forever.
   */
  permissions?: PermissionDesk;
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
          requireApproval: deps.requirePlanApproval,
        });
        if (result.overriddenSingle) {
          const message = overriddenSingleMessage(issueOrigin(number), result.overriddenSingle.liveParts);
          deps.errors?.record({ source: 'agent', message: `Agent ${agent.id}: ${message}` });
          // Told to the agent too, not just the operator — it asked for something
          // the world no longer allows and would otherwise assume it landed.
          return ok({ accepted: true, status: result.status, retired: result.retired, warning: message });
        }
        // Said out loud rather than left to be read off the status string: a
        // planner that thinks its parts are being worked would otherwise sit
        // waiting for siblings that will not start until a human clicks accept.
        const awaiting =
          result.status === 'awaiting_approval'
            ? { awaitingApproval: 'The plan is recorded, but nothing is scheduled until an operator approves it.' }
            : {};
        return ok({ accepted: true, status: result.status, retired: result.retired, ...awaiting });
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
    {
      name: MCP_TOOL_NAMES[4],
      description:
        'Say in one line what you are working on right now, so an operator watching the fleet can ' +
        "see it without reading your transcript. Replaces your card's preview line, which is " +
        'otherwise just whatever you last printed. Call it when you move on to a different part of ' +
        'the task, or before a long step (a full test run, a big refactor) so the quiet is explained. ' +
        'It is optional and it costs you nothing to skip: nothing infers that you are stuck from a ' +
        'gap between notes, so do not call it to prove you are alive. It asks nothing and changes ' +
        'nothing about your task — if you need a decision, use escalate instead.',
      inputSchema: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description:
              'One line, present tense, in the words you would use to a colleague: "reading how the ' +
              'dispatcher ranks candidates", "running the full suite after the rename". Say what you ' +
              'are doing, not that you are doing well.',
          },
        },
        required: ['note'],
      },
      handler: (args) => {
        const parsed = normaliseNote(args.note);
        if (!parsed.ok) return toolError(parsed.error);
        // Structural attribution, exactly as for `report_finding` and for the same
        // reason: this is a write that speaks in an agent's name to an operator.
        // There is no argument naming an agent, so there is nothing to forge with.
        const result = deps.agents.recordProgress(agent.id, parsed.note);
        if (!result.ok) return toolError(result.error);
        return ok({
          noted: true,
          note: parsed.note,
          notedAt: result.notedAt,
          ...(parsed.trimmed
            ? // Stored anyway rather than refused — a trimmed status line still
              // answers the question a rejected one would have left blank — but the
              // caller hears that it was cut so the next one fits.
              { trimmed: `Kept, trimmed to one line. Shorter notes read better on the card.` }
            : {}),
        });
      },
    },
    {
      name: MCP_TOOL_NAMES[5],
      description:
        'Harness-internal. You do not call this — Claude Code invokes it through --permission-prompt-tool ' +
        'when one of your tool calls is not covered by the operator allow-list, to ask the operator to ' +
        'allow or deny it. It blocks until they decide and returns the verdict.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'The tool the permission is for.' },
          input: { type: 'object', description: 'The tool input awaiting approval.' },
          tool_use_id: { type: 'string', description: 'Claude Code’s id for this tool use.' },
        },
      },
      // Returns the BARE `{behavior,…}` verdict `--permission-prompt-tool` expects,
      // through `toolJson` directly — never `ok()` (its `_status` envelope would
      // break Claude's permission parser) and never `toolError` (Claude reads an
      // error as a tool *failure*, not a structured deny).
      handler: async (args) => {
        if (!deps.permissions) {
          // Backstop off: deny rather than block. Claude sees a normal deny and the
          // agent carries on / escalates, exactly as with `mcp.permissionEscalation: false`.
          return toolJson({ behavior: 'deny', message: 'The permission backstop is disabled.' });
        }
        const toolName = typeof args.tool_name === 'string' && args.tool_name ? args.tool_name : 'a tool';
        const input =
          typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
        // Structural identity: like every write tool, the agent is the credential's,
        // never an argument. The tool/input come from Claude's permission machinery.
        const verdict = await deps.permissions.request(agent, task, toolName, input);
        return toolJson(verdict);
      },
    },
    {
      name: MCP_TOOL_NAMES[6],
      description:
        'Report the ticket you just created for the finding you were dispatched to file. Only for a ' +
        'filing job — if you were not dispatched to file a finding as a ticket, this is not your tool. ' +
        'Calling it is what completes the filing: until you do, the operator sees a finding whose ' +
        'ticket never appeared. Pass the ref of the item you created (or of the existing one you ' +
        'decided it duplicates).',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description:
              'The ticket, in the ref shape used everywhere else: "issue:314" for a GitHub issue or an ' +
              'Azure DevOps work item, "pr:42", "story:abc". A bare number is not accepted — say which.',
          },
        },
        required: ['ref'],
      },
      handler: (args) => {
        // The same parser `report_finding` uses for the item a finding is *about*,
        // so the ref a ticket is recorded under and the ref a finding names are the
        // same vocabulary — the cockpit links both through one `refUrls` lookup.
        const parsed = parseFindingRef(args.ref);
        if (!parsed.ok) return toolError(`Ticket rejected: ${parsed.error}`);
        if (!parsed.ref) return toolError('link_ticket requires the ref of the ticket you created.');
        // Structural identity again, and here it does the whole job: the finding is
        // resolved from the credential (agent -> task -> its job -> the finding that
        // job was created for), so there is no finding argument to point at someone
        // else's, and an agent on any other kind of task simply has no finding to
        // link.
        const result = deps.agents.linkTicket(agent.id, parsed.ref);
        if (!result.ok) return toolError(result.error);
        return ok({
          linked: true,
          finding: { id: result.finding.id, status: result.finding.status, ticketRef: result.finding.ticketRef },
          note: 'Recorded against the finding. Your filing task is done.',
        });
      },
    },
    {
      name: MCP_TOOL_NAMES[7],
      description:
        'Say whether the ISSUE you were dispatched for is now finished — not whether your own turn is ' +
        'over. Call it once, at the end of your work, before you finish. This is the only thing that ' +
        'tells the harness a ticket is concluded: a tracker state like "In Review" does not distinguish ' +
        '"waiting on test" from "still has work in it", so if you say nothing the harness parks the ' +
        'ticket and waits for a human rather than guessing. Say "done" only if everything the issue ' +
        'asked for is delivered; say "more_work" if you did part of it or found more is needed, and the ' +
        'issue will come back round with your note in front of the next agent.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...CONCLUSION_VERDICTS],
            description: CONCLUSION_VERDICTS.map((v) => `${v}: ${CONCLUSION_VERDICT_HELP[v]}`).join('. '),
          },
          note: {
            type: 'string',
            description:
              'What you delivered, or what is still outstanding and why. An operator decides what happens ' +
              'to the ticket from this alone, and for more_work the next agent reads it as their starting ' +
              'point — so be specific about what is left, not about what you did.',
          },
        },
        required: ['status', 'note'],
      },
      handler: (args) => {
        const parsed = validateConclusion(args);
        if (!parsed.ok) return toolError(`Conclusion rejected: ${parsed.error}`);
        // Structural identity, and here it carries more than attribution: the
        // origin decides whether there is anything to conclude at all. A part
        // agent is refused rather than scoped down — see `conclusionOrigin`.
        const result = deps.agents.recordConclusion(agent.id, parsed.verdict, parsed.note);
        if (!result.ok) return toolError(result.error);
        return ok({
          concluded: true,
          issue: result.conclusion.originRef,
          status: result.conclusion.verdict,
          // Said in the response as well as the description: an agent that
          // believes "done" closed the ticket would stop looking at it, and an
          // agent that believes "more_work" scheduled something would wait.
          note:
            parsed.verdict === 'done'
              ? 'Recorded. The harness will schedule nothing further for this issue. It does not close the ' +
                'ticket in the tracker — that stays a human decision.'
              : 'Recorded. The issue returns to pickup once its pull request is out of review, and your note ' +
                'goes to whoever picks it up. Nothing is dispatched right now.',
        });
      },
    },
    {
      name: MCP_TOOL_NAMES[8],
      description:
        'Say whether the ISSUE you were dispatched to assess is finished. You are the second look: ' +
        'another agent did the work and said what it believed it delivered, and your job is to check ' +
        "that against the repository you are standing in and the harness's record of what was done " +
        '(world_read on your issue). Say "delivered" only if what the issue asked for is actually ' +
        'present — that stops the harness scheduling anything further, though it does not close the ' +
        'ticket and can be undone. Say "more_work" if something is missing or you could not verify it, ' +
        'and the issue comes back round with your summary in front of the next agent. If you are torn, ' +
        'say more_work: a wrong "delivered" parks real work silently, a wrong "more_work" costs one agent.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...ASSESSMENT_VERDICTS],
            description: ASSESSMENT_VERDICTS.map((v) => `${v}: ${ASSESSMENT_VERDICT_HELP[v]}`).join('. '),
          },
          summary: {
            type: 'string',
            description:
              'What you found, and on what evidence — which pull requests delivered what, and whether the ' +
              'harness watched them merge or assumed it. For more_work, precisely what is missing: the next ' +
              'agent starts from this.',
          },
        },
        required: ['status', 'summary'],
      },
      handler: (args) => {
        const parsed = validateAssessment(args);
        if (!parsed.ok) return toolError(`Assessment rejected: ${parsed.error}`);
        // Structural identity, and here it decides whether there is anything to
        // assess at all: an agent that did the work is refused rather than scoped
        // down, because judging your own delivery is not an assessment.
        const result = deps.agents.recordAssessment(agent.id, parsed.verdict, parsed.summary);
        if (!result.ok) return toolError(result.error);
        return ok({
          assessed: true,
          issue: result.issueOrigin,
          status: result.verdict,
          note:
            parsed.verdict === 'delivered'
              ? 'Recorded. The harness will not pick this issue up again while the verdict stands — it ends ' +
                'when the issue changes in the tracker or someone clears it. The ticket is not closed; that ' +
                'stays a human decision.'
              : 'Recorded. The issue is back in the queue and your summary goes to whoever picks it up. ' +
                'Nothing is dispatched right now.',
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
