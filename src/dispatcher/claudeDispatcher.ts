import { PtySession } from '../pty/ptySession.js';
import type { PtyBackend } from '../pty/backend.js';
import type { Dispatcher, DispatchContext, DispatchResult } from './dispatcher.js';
import { parseActions } from './actions.js';
import type { IssuePickupPolicy } from './issuePickup.js';

const PLAN_START = '@@LUBBDUBB_PLAN_START@@';
const PLAN_END = '@@LUBBDUBB_PLAN_END@@';

export interface ClaudeDispatcherOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Give up on a cycle after this long and fall back to no_op. */
  timeoutMs?: number;
  /** Dispatcher-level issue-pickup gate + priority scheme, surfaced as prompt guidance. */
  issuePickup?: IssuePickupPolicy;
}

/**
 * The LLM decision-maker: a Claude Code "desk" session, driven over the same
 * {@link PtySession} abstraction as the agents, that reads the full state and
 * emits a structured plan. It is asked to bracket a JSON action list between
 * sentinels; that block is extracted and validated with the exact same schema
 * the rule dispatcher uses, so a hallucinated action can never be executed.
 *
 * The "read structured output from an interactive REPL" problem is solved once
 * here (via the sentinel protocol) and reused.
 */
export class ClaudeDispatcher implements Dispatcher {
  constructor(
    private readonly backend: PtyBackend,
    private readonly opts: ClaudeDispatcherOptions,
  ) {}

  async decide(ctx: DispatchContext): Promise<DispatchResult> {
    const prompt = buildPrompt(ctx, this.opts.issuePickup);
    const session = new PtySession(this.backend, {
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd,
    });

    let buffer = '';
    const timeoutMs = this.opts.timeoutMs ?? 120_000;

    const output = await new Promise<string>((resolvePromise) => {
      const finish = (): void => {
        clearTimeout(timer);
        try {
          session.kill();
        } catch {
          /* already dead */
        }
        resolvePromise(buffer);
      };

      const timer = setTimeout(finish, timeoutMs);

      session.on('output', (delta: string) => {
        buffer += delta;
        if (buffer.includes(PLAN_END)) finish();
      });
      session.on('done', finish);
      session.on('failed', finish);
      session.on('exit', finish);

      session.start();
      // Feed the decision prompt into the interactive session.
      session.send(prompt);
    });

    const json = extractPlan(output);
    if (!json) {
      return {
        actions: [],
        rejected: [],
        rationale: 'Claude dispatcher produced no parseable plan block; treating as no-op.',
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(json);
    } catch (err) {
      return {
        actions: [],
        rejected: [{ raw: json, error: `plan JSON parse failed: ${(err as Error).message}` }],
        rationale: 'Claude dispatcher emitted invalid JSON.',
      };
    }

    const actionsRaw = (parsedJson as { actions?: unknown }).actions ?? parsedJson;
    const parsed = parseActions(actionsRaw);
    const rationale =
      typeof (parsedJson as { rationale?: unknown }).rationale === 'string'
        ? (parsedJson as { rationale: string }).rationale
        : 'Claude dispatcher plan.';
    return { ...parsed, rationale };
  }
}

/**
 * Turn the issue-pickup policy into prompt guidance so the LLM dispatcher honours
 * the same gate + priority scheme the rule dispatcher enforces deterministically.
 */
function issuePickupGuidance(pickup?: IssuePickupPolicy): string {
  if (!pickup) return '';
  const rules: string[] = [];
  if (pickup.pickupLabel) {
    rules.push(
      `Only start a code agent for an open issue whose labels include "${pickup.pickupLabel}". Leave other open issues visible but untouched.`,
    );
  }
  const scheme = Object.entries(pickup.priorityLabels);
  if (scheme.length) {
    rules.push(
      `Issue priority is label-encoded (${scheme.map(([l, w]) => `${l}=${w}`).join(', ')}; default ${pickup.defaultPriority}). Prefer higher-priority issues when you can't start them all this cycle.`,
    );
  }
  return rules.length ? `\n\nIssue pickup policy (respect these):\n- ${rules.join('\n- ')}` : '';
}

function extractPlan(output: string): string | null {
  const start = output.indexOf(PLAN_START);
  const end = output.indexOf(PLAN_END);
  if (start === -1 || end === -1 || end < start) return null;
  return output.slice(start + PLAN_START.length, end).trim();
}

function buildPrompt(ctx: DispatchContext, pickup?: IssuePickupPolicy): string {
  const steering = ctx.steeringPriorities.length
    ? `\n\nOperator steering priorities (respect these):\n- ${ctx.steeringPriorities.join('\n- ')}`
    : '';
  return [
    'You are the dispatcher for an autonomous software-engineering harness.',
    'Given the current world and fleet state, decide what to do this cycle.',
    `You may start at most ${ctx.agentHeadroom} new agent(s) this cycle.`,
    'Only use these action types: dispatch_code_agent, dispatch_desk_agent, escalate_to_human, respond_to_agent, reply_on_pr, no_op.',
    'Every action must include a short "reason".',
    'For reply_on_pr, include a "confidence" field (0..1) reflecting how sure you are the draft is correct and safe to send. The harness auto-sends only above its configured threshold; anything less is drafted and escalated for a human. When unsure, omit it or use a low value.',
    `Respond with ONLY a JSON object bracketed exactly like this: ${PLAN_START} {"rationale": "...", "actions": [...]} ${PLAN_END}`,
    steering,
    issuePickupGuidance(pickup),
    '',
    'STATE:',
    JSON.stringify(
      {
        world: ctx.world,
        tasks: ctx.tasks,
        agents: ctx.agents,
        openEscalations: ctx.openEscalations,
      },
      null,
      2,
    ),
  ].join('\n');
}
