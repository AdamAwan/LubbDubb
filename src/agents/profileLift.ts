import type { Task } from '../types.js';
import type { TaskStore } from '../store/tasks.js';

// → docs/spec/10-agent-runtimes.md

export interface LiftProfile {
  name: string;
  model: string;
  effort: string | null;
  permissionMode: string | null;
  autoApprove: boolean;
}

function liftNote(from: string | null, to: string): string {
  const previous = from === null ? 'a cheaper profile' : `the **${from}** profile`;
  return (
    `## The conversation above is not yours, and it did not work\n\n` +
    `Everything already in this conversation was written by an agent running on ${previous}, on this ` +
    `same concern. It did not finish it. An operator watched it work and judged the concern beyond ` +
    `that profile rather than merely unlucky, so they moved the run to **${to}** — you — mid-flight, ` +
    `and stopped that agent where it stood.\n\n` +
    `That judgement is the whole reason you are here, so do not spend it continuing where the ` +
    `transcript stops. Read what is above as **a report from somebody else whose reasoning is known ` +
    `to have failed**, not as your own memory:\n\n` +
    `- Re-derive the problem yourself, from the repository and from the concern as restated below. ` +
    `Where the transcript and what you read disagree, what you read is the truth.\n` +
    `- Treat every conclusion in it as unverified — a diagnosis, a root cause, a "this file is the ` +
    `problem", a ruled-out approach. Some of it is probably right, and which part is right is exactly ` +
    `what the earlier agent could not tell.\n` +
    `- Its **observations** are worth more than its **conclusions**: a command it ran and the output ` +
    `it got are facts you need not buy twice; what it decided those facts meant is not.\n` +
    `- The approach it had in flight is the approach that was not working. Do not resume it by ` +
    `default. If you land on it anyway, say what you now know that makes it right.\n\n` +
    `The worktree is exactly as that agent left it — its commits are on the branch and anything it ` +
    `left uncommitted is still in the tree, sound or not. Read the state back before you build on it.\n\n` +
    `Start by saying, in a line or two, what you think is actually going on and where the earlier run ` +
    `went wrong. Then work it.`
  );
}

export function liftedTask(task: Task, profile: LiftProfile): Parameters<TaskStore['createTask']>[0] {
  return {
    kind: task.kind,
    title: task.title,
    prompt: `${liftNote(task.profile ?? null, profile.name)}\n\n${task.prompt}`,
    branch: task.branch,
    originRef: task.originRef,
    originTitle: task.originTitle,
    originSummary: task.originSummary,
    dispatchReason: task.dispatchReason,
    rule: task.rule ?? null,
    ciChecks: task.ciChecks ?? null,
    mcpServers: task.mcpServers ?? null,
    model: profile.model,
    effort: profile.effort,
    permissionMode: profile.permissionMode ?? task.permissionMode ?? null,
    permissionAutoApprove: profile.autoApprove,
    profile: profile.name,
    profileSource: 'pin',
  };
}
