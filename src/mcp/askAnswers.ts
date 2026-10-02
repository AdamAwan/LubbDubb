import type { AskKind, AskRow, AskSubject } from '../asks/askRow.js';
import type { ProposalKind } from '../types.js';
import type { DesktopToolName } from './names.js';

// → docs/spec/11-mcp-tools.md#what-answers-the-ask-in-front

interface ToolCall {
  tool: DesktopToolName;
  args: Record<string, unknown>;
}

type AnswerWith =
  | (ToolCall & {
      in: 'claude-code';
      /** The fields the operator's answer fills, each with what it means. The ids in `args` are already right. */
      choose: Record<string, string>;
      /** Reads that give the operator what they need to decide, before the answer is sent. */
      readFirst?: ToolCall[];
      /** Another tool that also settles this row, and when it is the right one. */
      instead?: ToolCall & { when: string };
      note?: string;
    })
  | { in: 'cockpit'; why: string; link: string | null }
  | { in: 'nowhere'; why: string; link: string | null };

interface AnswerContext {
  /** The cockpit page that opens this ask's panel, or null where no URL can be built. */
  link: string | null;
  profileNames: string[];
  /** The kind of proposal an id names — `plan` asks are two kinds, and only one takes the ticket verdicts. */
  proposalKind(id: string): ProposalKind | null;
}

type Answerer = (row: AskRow, ctx: AnswerContext) => AnswerWith;

function issueNumberOf(row: AskRow): number | null {
  if (row.subject.type === 'issue') return row.subject.issueNumber;
  const match = /^issue:(\d+)/.exec(row.goalRef ?? row.originRef ?? '');
  return match ? Number(match[1]) : null;
}

function subjectOf<T extends AskSubject['type']>(row: AskRow, type: T): Extract<AskSubject, { type: T }> | null {
  return row.subject.type === type ? (row.subject as Extract<AskSubject, { type: T }>) : null;
}

function cockpit(why: string): Answerer {
  return (_row, ctx) => ({ in: 'cockpit', why, link: ctx.link });
}

function nowhere(why: string): Answerer {
  return (_row, ctx) => ({ in: 'nowhere', why, link: ctx.link });
}

function unanswerable(ctx: AnswerContext): AnswerWith {
  return {
    in: 'cockpit',
    why: 'This row is not about a record any tool on this channel can answer, so it is answered from its panel.',
    link: ctx.link,
  };
}

const ESCALATION_CHOICES: Record<string, string> = {
  response: 'Free text, read by the agent verbatim and acted on.',
  answers: 'One answer per question, in order, where the ask carries `questions` (null for one left unanswered).',
  dismiss: 'true clears it without an answer, releasing the agent told nothing — only on the say-so.',
};

const escalation: Answerer = (row, ctx) => {
  const subject = subjectOf(row, 'escalation');
  if (subject === null) return unanswerable(ctx);
  return {
    in: 'claude-code',
    tool: 'escalation_answer',
    args: { id: subject.escalationId },
    choose: ESCALATION_CHOICES,
  };
};

const permission: Answerer = (row, ctx) => {
  const subject = subjectOf(row, 'escalation');
  if (subject === null) return unanswerable(ctx);
  return {
    in: 'claude-code',
    tool: 'escalation_answer',
    args: { id: subject.escalationId },
    choose: {
      permission: '"allow" lets the blocked tool call run; "deny" refuses it.',
      note: 'Why, shown with a denial.',
    },
  };
};

const VERDICTS: Partial<Record<AskKind, string>> = {
  plan:
    '"accept" releases the plan and the fleet starts spending on it; "reject" sends it back to a planner; ' +
    '"close_ticket" closes the ticket with `note` posted as the reason; "hold_ticket" takes the watch tag off.',
  merge: '"accept" MERGES the pull request — it cannot be undone from here; "reject" leaves it unmerged.',
  reply: '"accept" POSTS the drafted comment, publicly; "reject" drops it.',
  shortfall: '"accept" sends the goal back as the proposal names; "reject" leaves it delivered.',
  validation_plan: '"accept" releases the check set (rows in `declined` struck with a reason); "reject" sends it back.',
};

/* A `plan_amendment` is drawn as `plan`, and `close_ticket` / `hold_ticket` are refused on it. */
const AMENDMENT_VERDICT =
  '"accept" replaces the running plan’s document with the amendment; "reject" keeps the plan as it stands.';

const EXTRA_CHOICES: Partial<Record<AskKind, Record<string, string>>> = {
  plan: {
    acknowledged:
      'Every caveat id proposal_read lists, once the operator has read each one. A plan is refused without them.',
    answers: 'What the operator said about a caveat, verbatim, as {id, answer}. Optional; not an acknowledgement.',
  },
  validation_plan: { declined: 'The rows the operator said no to, as {letter, reason}. The reason is required.' },
};

const proposal: Answerer = (row, ctx) => {
  const subject = subjectOf(row, 'escalation');
  if (subject === null) return unanswerable(ctx);
  if (subject.planWithheld === true) {
    return {
      in: 'cockpit',
      why:
        'The plan is withheld until the operator reveals it on the goal in the cockpit, where their prediction is ' +
        'asked first. It can be neither read nor decided here until then.',
      link: ctx.link,
    };
  }
  if (subject.proposalId === null) return escalation(row, ctx);
  return {
    in: 'claude-code',
    tool: 'proposal_decide',
    args: { id: subject.proposalId },
    choose: {
      verdict:
        ctx.proposalKind(subject.proposalId) === 'plan_amendment'
          ? AMENDMENT_VERDICT
          : (VERDICTS[row.kind] ?? '"accept" performs the act; "reject" performs nothing.'),
      note: 'The reason, recorded with the verdict. Ask for one on a rejection.',
      ...EXTRA_CHOICES[row.kind],
    },
    readFirst: [{ tool: 'proposal_read', args: { id: subject.proposalId } }],
  };
};

const shortfall: Answerer = (row, ctx) => {
  const answer = proposal(row, ctx);
  const issue = issueNumberOf(row);
  if (answer.in !== 'claude-code' || answer.tool !== 'escalation_answer' || issue === null) return answer;
  return {
    ...answer,
    instead: {
      tool: 'goal_gate',
      args: { issue },
      when: 'The operator says the goal is in fact finished: `overrule` with why the shortfall is wrong delivers it.',
    },
  };
};

const recovery: Answerer = (row, ctx) => {
  const subject = subjectOf(row, 'recovery');
  if (subject === null || subject.taskIds.length === 0) return unanswerable(ctx);
  return {
    in: 'claude-code',
    tool: 'recovery_decide',
    args: { taskId: subject.taskIds[0] },
    choose: {
      verdict:
        '"restore" re-opens the agent in its session and worktree; "requeue" discards the run and puts the work ' +
        'back for a fresh agent; "remove" drops it entirely.',
    },
    ...(subject.taskIds.length > 1
      ? { note: `One call per task — the others are ${subject.taskIds.slice(1).join(', ')}.` }
      : {}),
  };
};

const SETTLE_CHOICES: Record<string, string> = {
  status: '"done" once the work has actually been done; "declined" if the operator refuses it.',
  note: 'What was done, or why it was refused. Required on "declined".',
};

function humanTask(extra: (row: AskRow) => Partial<Extract<AnswerWith, { in: 'claude-code' }>> = () => ({})): Answerer {
  return (row, ctx) => {
    const subject = subjectOf(row, 'human_task');
    if (subject === null) return unanswerable(ctx);
    return {
      in: 'claude-code',
      tool: 'human_task_settle',
      args: { id: subject.taskId },
      choose: SETTLE_CHOICES,
      ...extra(row),
    };
  };
}

function watchInstead(row: AskRow): Partial<Extract<AnswerWith, { in: 'claude-code' }>> {
  const issue = issueNumberOf(row);
  if (issue === null) return {};
  return {
    instead: {
      tool: 'goal_control',
      args: { issue, watched: true },
      when: 'The operator wants the fleet to work what the row names: watching it is the answer.',
    },
  };
}

const validate = humanTask((row) => {
  const issue = issueNumberOf(row);
  return {
    ...(issue === null ? {} : { readFirst: [{ tool: 'validation_read' as const, args: { issue } }] }),
    note:
      'The checks are run with validation_claim and validation_report — at the keyboard, by somebody who actually ' +
      'carries each one out. Settle this row once they are.',
  };
});

const supply = humanTask((row) => ({
  ...watchInstead(row),
  note: 'If it asks for a secret or a credential, the operator supplies it themselves — never through this chat.',
}));

const burn = humanTask(() => ({
  note: 'Lifting the run to a deeper profile is done in the cockpit; this row settles here.',
}));

const intake: Answerer = (row, ctx) => {
  const issue = issueNumberOf(row);
  if (issue === null) return unanswerable(ctx);
  return {
    in: 'claude-code',
    tool: 'goal_gate',
    args: { issue },
    choose: {
      appraisal: '"workable" works it anyway; "unclear" agrees and keeps it held; "clear" has it appraised afresh.',
      summary: 'Why, in the operator’s words.',
    },
    readFirst: [{ tool: 'goal_read', args: { issue } }],
  };
};

const profile: Answerer = (row, ctx) => {
  const issue = issueNumberOf(row);
  if (issue === null) return unanswerable(ctx);
  const names = ctx.profileNames.length > 0 ? ` One of: ${ctx.profileNames.join(', ')}.` : '';
  return {
    in: 'claude-code',
    tool: 'goal_control',
    args: { issue },
    choose: { profile: `The profile this goal runs on, by name, or "" to clear the pin.${names}` },
  };
};

const placement: Answerer = (row, ctx) => {
  const issue = issueNumberOf(row);
  if (issue === null) return unanswerable(ctx);
  const choose: Record<string, string> =
    row.placementField === 'areaPath'
      ? { areaPath: 'The board to move it to, or null to leave it where it is.' }
      : { parent: 'The container to hang it off, e.g. 240, or null for "no container".' };
  return { in: 'claude-code', tool: 'goal_placement', args: { issue }, choose };
};

const assign: Answerer = (row, ctx) => {
  const pr = subjectOf(row, 'pull_request')?.prNumber ?? null;
  if (pr === null) return unanswerable(ctx);
  return {
    in: 'claude-code',
    tool: 'pr_assign',
    args: { pr },
    choose: {
      person: 'Somebody from the shortlist, by id or name — they are assigned on the tracker and told.',
      decline: 'true answers "nobody"; nothing is written.',
    },
    readFirst: [{ tool: 'pr_assign', args: { pr } }],
  };
};

const description: Answerer = (row, ctx) => {
  const pr = subjectOf(row, 'description_check')?.prNumber ?? null;
  if (pr === null) return unanswerable(ctx);
  return {
    in: 'claude-code',
    tool: 'description_dismiss',
    args: { pr },
    choose: {},
    note:
      'Sent only when the operator disagrees with the findings and leaves the description as it is. If they ' +
      'agree, the fix is theirs to write in their own words — no tool writes it.',
  };
};

/** Total over {@link AskKind}, so a new kind is placed deliberately. */
const ANSWER_WITH: Record<AskKind, Answerer> = {
  escalation,
  permission,
  plan: proposal,
  merge: proposal,
  reply: proposal,
  validation_plan: proposal,
  shortfall,
  recovery,
  bench: humanTask(),
  close_out: humanTask(() => ({
    note: 'Closing the ticket is done on the tracker or in the cockpit; "done" here records a close taken elsewhere.',
  })),
  validate,
  watch: humanTask(),
  unwatched: humanTask(watchInstead),
  supply,
  burn,
  intake,
  profile,
  placement,
  assign,
  description_wrong: description,
  description_note: description,
  config: cockpit('A deployment setting, changed on the setup page where it can show what it changes.'),
  config_gap: cockpit('A deployment setting, changed on the setup page where it can show what it changes.'),
  upgrade: cockpit('An upgrade changes what this harness is, and is taken from the cockpit.'),
  project_pull: cockpit('Pulling the project changes what this harness runs, and is taken from the cockpit.'),
  limit: cockpit(
    "An agent parked on the account's usage limit. The decision is the account's allowance, made in the cockpit.",
  ),
  sitting: cockpit(
    'The operator’s own prediction and criteria, asked before the planner. A prediction typed through an ' +
      'assistant is not the blind guess it exists to be, so it is never taken here.',
  ),
  describe: cockpit(
    'The description is the operator’s own words. This channel checks one (/lubbdubb:describe) and never writes one.',
  ),
  assigned: nowhere(
    'Somebody put this pull request on the operator where the fleet cannot see it. Nothing in the harness acts ' +
      'on it; the answer is the review itself.',
  ),
  dispatch: nowhere(
    'A dispatch the harness keeps refusing, for the reason the row names. There is no verdict to give: the ' +
      'answer is fixing what the refusal says.',
  ),
};

export function answerWith(row: AskRow, ctx: AnswerContext): AnswerWith {
  return ANSWER_WITH[row.kind](row, ctx);
}
