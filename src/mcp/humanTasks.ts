/**
 * The `request_human_task` tool's pure layer: what a well-formed ask looks like.
 * No store, no transport — so the validation is testable on its own and the tool
 * handler is left with nothing but the persist-and-envelope step, exactly as
 * `findings.ts` is for `report_finding`.
 *
 * ## The gap this closes
 *
 * Every unit of work the harness spawned was dispatched to an agent. Work only a
 * person can do — flipping a setting in a console nobody gave the fleet an
 * account for, plugging in hardware, looking at a rendered screen and saying
 * whether it is right — had no representation at all. An agent that hit one could
 * only `escalate`, which is a different shape: an escalation blocks that one agent
 * on an open socket and is settled by typing an answer back into its session,
 * where this is durable work with its own lifecycle that other work can depend on.
 *
 * ## Does asking for one put work on the fleet? No.
 *
 * `report_finding` queues nothing because a queued job is dispatched ahead of
 * every world-driven rule, so an agent that could queue jobs could spend another
 * agent's slot. This tool is the other side of that same argument and lands
 * differently: it schedules no agent, takes no slot, cuts no worktree and spends
 * no budget. What it spends is an operator's attention — one card, declined in a
 * click — which is strictly less than `escalate` already spends, since that also
 * holds a slot and a worktree open until it is answered.
 *
 * The half that *could* hold work off the fleet is a plan part declared
 * `expectedKind: 'human'`, and that arrives through `plan_submit` → the approval
 * gate, not through this tool. So the capability an agent gains here is "ask a
 * person", never "stop the fleet", and nothing in the dispatcher reads the
 * `human_tasks` table.
 */

import type { HumanTaskInput } from '../types.js';

/** The ask is a panel headline, so it is bounded the way a finding's summary is. */
const MAX_TITLE_LENGTH = 160;
/** The instructions. `conclude_work`'s note bound, for its reason: an operator reads it to act. */
const MAX_DETAIL_LENGTH = 2000;

/**
 * Validate a `request_human_task` call. Pure.
 *
 * **A newline in the title is refused**, and that refusal is the load-bearing
 * part. The only cheap moment to fix a blob is the requesting agent's own turn,
 * where it costs one tool call; by the time an operator is reading an unreadable
 * row it costs them every time they open the panel. The error names `detail` as
 * where the rest belongs, because an error that only said "too long" would get
 * the same paragraph back, shortened.
 *
 * `detail` is optional on purpose — a required field an agent has nothing for
 * comes back as "N/A", and a list of those is worse than a bare title.
 */
export function validateHumanTask(args: unknown): { ok: true; input: HumanTaskInput } | { ok: false; error: string } {
  const raw = (args ?? {}) as Record<string, unknown>;

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title.length === 0) return { ok: false, error: 'title is required — say in one line what a person must do.' };
  if (title.includes('\n'))
    return {
      ok: false,
      error: 'title must be one line — an operator scans it in a list. Put the instructions in detail.',
    };
  if (title.length > MAX_TITLE_LENGTH)
    return {
      ok: false,
      error: `title must be at most ${MAX_TITLE_LENGTH} characters — it is a headline. Put the rest in detail.`,
    };

  if (raw.detail !== undefined && typeof raw.detail !== 'string')
    return { ok: false, error: 'detail must be a string of markdown, or omitted.' };
  const detail = typeof raw.detail === 'string' && raw.detail.trim().length > 0 ? raw.detail.trim() : null;
  if (detail !== null && detail.length > MAX_DETAIL_LENGTH)
    return { ok: false, error: `detail must be at most ${MAX_DETAIL_LENGTH} characters.` };

  return { ok: true, input: { title, detail } };
}
