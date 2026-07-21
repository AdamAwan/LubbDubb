import { PtySession } from '../pty/ptySession.js';
import type { PtyBackend } from '../pty/backend.js';
import type { Dispatcher, DispatchContext, DispatchResult } from './dispatcher.js';
import { parseActions } from './actions.js';

const PLAN_START = '@@LUBBDUBB_PLAN_START@@';
const PLAN_END = '@@LUBBDUBB_PLAN_END@@';

export interface ClaudeDispatcherOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Give up on a cycle after this long and fall back to no_op. */
  timeoutMs?: number;
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
    const prompt = buildPrompt(ctx);
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
    const rationale = typeof (parsedJson as { rationale?: unknown }).rationale === 'string'
      ? (parsedJson as { rationale: string }).rationale
      : 'Claude dispatcher plan.';
    return { ...parsed, rationale };
  }
}

function extractPlan(output: string): string | null {
  const start = output.indexOf(PLAN_START);
  const end = output.indexOf(PLAN_END);
  if (start === -1 || end === -1 || end < start) return null;
  return output.slice(start + PLAN_START.length, end).trim();
}

function buildPrompt(ctx: DispatchContext): string {
  const steering = ctx.steeringPriorities.length
    ? `\n\nOperator steering priorities (respect these):\n- ${ctx.steeringPriorities.join('\n- ')}`
    : '';
  return [
    'You are the dispatcher for an autonomous software-engineering harness.',
    'Given the current world and fleet state, decide what to do this cycle.',
    `You may start at most ${ctx.agentHeadroom} new agent(s) this cycle.`,
    'Only use these action types: dispatch_code_agent, dispatch_desk_agent, escalate_to_human, respond_to_agent, reply_on_pr, no_op.',
    'Every action must include a short "reason".',
    `Respond with ONLY a JSON object bracketed exactly like this: ${PLAN_START} {"rationale": "...", "actions": [...]} ${PLAN_END}`,
    steering,
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
