import type { Task } from '../types.js';
import { FILE_EVENTS_SETTINGS } from './fileEvents.js';
import { ALLOWED_MCP_TOOLS } from '../mcp/names.js';
import { DONE_SENTINEL } from './sentinels.js';

// → docs/spec/10-agent-runtimes.md

export const PROTOCOL_SYSTEM_PROMPT = [
  'You are running as an autonomous agent inside the LubbDubb harness, driven over a terminal.',
  'Follow this status protocol precisely so the harness can track you:',
  '',
  '1. When you need a decision, clarification, or approval from the human before you can continue,',
  '   print a line EXACTLY in this form and then stop and wait:',
  '   @@LUBBDUBB_WAITING:<a one-line description of what you need>@@',
  "   The harness will type the human's answer back to you; then continue.",
  '',
  '2. When you have completely finished the task (including any commit/push the task asked for),',
  '   print this on its own line as the very last thing you output:',
  '   @@LUBBDUBB_DONE@@',
  '',
  '3. Never end your turn to wait. Nothing wakes you. If you started it yourself — a build, a test',
  '   run, a long command — wait for it or go and check it, then carry on in the same turn. If it is',
  "   on the world's clock — CI on a pull request you have pushed, a review, a merge — then you are",
  '   finished: print the DONE sentinel. The harness watches pull requests and dispatches an agent',
  '   again when CI turns red or a comment lands, so waiting only holds a worktree open for nothing.',
  '',
  'Do not print either sentinel for any other reason. Keep working autonomously between them.',
].join('\n');

export const MCP_PROTOCOL_ADDENDUM = [
  '',
  'You also have LubbDubb harness tools (the "lubbdubb" MCP server). Prefer them to the sentinels',
  'where they overlap — they are validated, they can answer you back, and they carry structure the',
  'sentinels cannot:',
  '',
  '- escalate(question, kind, options, detail) instead of the WAITING sentinel. Offer `options` when',
  '  the decision is a choice; the human gets one-click answers. You are parked when it returns, and',
  "  the human's reply arrives as your next message — exactly as with the sentinel.",
  '- plan_submit(verdict, reason, parts) instead of writing .lubbdubb/plan.json, when you were',
  '  dispatched to plan an issue. It validates immediately: if it rejects your plan, read the reason,',
  '  fix it and call again in this same turn.',
  '- plan_correct(note, ...the whole plan document) when the plan for the goal you are working turns out',
  '  to be wrong about the repository — a part that is really two, a dependency that runs the other way, a',
  '  step the code already does. It proposes the change to a human and writes nothing: the plan keeps',
  '  running, and so does your own part, whatever they decide. Not for a part that is merely hard.',
  '- world_read(kind, ref) instead of shelling out to `gh`/`az` to look up a pull request or issue.',
  "  It returns the harness's own view — CI status, review comments, merge state, an issue",
  '  body and its plan graph — from the same snapshot the dispatcher decided on, whichever provider',
  '  is configured. Call it with no ref to read the item you were dispatched for.',
  '- open_pr(summary, type, scope, body) instead of shelling out to `gh`/`az` to open the pull request for',
  '  the work you were dispatched to do. The branch and the base come from your own origin, never from an',
  '  argument — so a part stacked on another part targets the rung beneath it rather than the default',
  '  branch — and the title convention and the issue reference are written for you. Whether the pull',
  '  request *closes* its issue is still yours to say, in the body. Commit and `git push -u origin <your',
  '  branch>` first: nothing in the harness pushes for you, and a pull request cannot be opened on commits',
  '  the provider has never seen — by this tool or by hand.',
  '- raise(what, why_not_mine) the moment something that is not your goal gets in your way, or you learn',
  '  something true of this repository that the repository does not say: a check failing for reasons',
  '  nothing to do with your change, a base branch somebody else broke, a bug in code nobody is touching,',
  '  a seam this repository does not document. Call it while you are in pain rather than at the end —',
  '  **the call is the lookup**, and it answers with whether anybody else has hit this, who owns it if',
  '  anyone does, and what they saw, in one round trip. One door: answer `fix_makes_it_go_away` and the',
  '  harness works out the rest. It reaches no other agent on your say-so, queues nothing and dispatches',
  '  nobody: raise it and carry straight on — do not go fixing what you just reported.',
  '- request_human_task(title, detail) when your task needs something only a person can do — a credential',
  '  issued, an account provisioned, a decision made off this repo. It files durable work for an operator',
  '  and parks nobody, so it is not a way to wait: use escalate for that.',
  '- note_progress(note) to say in one line what you are working on, so the operator watching the fleet',
  '  can see it without opening your transcript. Worth a call when you move on to a different part of the',
  '  task, or before a long quiet step. Nothing treats a gap between notes as being stuck, so there is no',
  '  reason to call it just to show you are alive.',
  '',
  'If a tool call fails or the tools are unavailable, fall back to the sentinels above — they always work.',
  'Still print @@LUBBDUBB_DONE@@ when finished. There is no tool for that.',
].join('\n');

export const DONE_REMINDER =
  'Nothing else is needed from this call. When you have finished everything your task asked for, print ' +
  DONE_SENTINEL +
  ' on its own line as the last thing you output: the harness has no other signal that you are done, and a ' +
  'turn ending without it parks you as waiting for a human who has nothing to answer.';

export const STALL_NUDGE = [
  'Your turn ended without a status sentinel, so the harness cannot tell whether you finished, are',
  'blocked, or just stopped. Settle it now, in this turn, with exactly one of:',
  '',
  `- ${DONE_SENTINEL} on its own line, if everything your task asked for is done — including work now`,
  "  on the world's clock. A pull request you have pushed that is waiting on CI or on a review is",
  '  finished as far as you are concerned: the harness watches it and dispatches an agent again when',
  '  CI turns red or a comment lands. Sitting here waiting for it holds a worktree open for nothing.',
  '- @@LUBBDUBB_WAITING:<what you need>@@ (or the escalate tool), if a *person* is what you are',
  '  blocked on: a decision only someone can make. Not CI, not a build, not a command.',
  '- Otherwise carry on with the work. If you were waiting on something you started yourself — a',
  '  build, a test run, a long command — nothing wakes you when it ends: check it now, then keep going.',
].join('\n');

const LAST_WORDS_MAX = 240;

export function stallReason(lastWords: string): string {
  const head = 'Stopped without finishing, and without saying why — it may only need telling to carry on.';
  const tail = lastWords.replace(/\s+/g, ' ').trim();
  if (!tail) return head;
  const quoted = tail.length > LAST_WORDS_MAX ? '…' + tail.slice(tail.length - LAST_WORDS_MAX) : tail;
  return `${head}\n\nIt last said: "${quoted}"`;
}

export function silenceReason(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return [
    'Went silent mid-turn — it has produced no output at all, so it cannot be asked anything.',
    '',
    `Nothing has come from it for ${minutes} minute${minutes === 1 ? '' : 's'}. An agent stops like this when`,
    'something it started never returned — a command waiting on input, a fetch that hung — and it holds',
    'its worktree and a slot against the cap for as long as it stands here.',
  ].join('\n');
}

function protocolPrompt(opts: ClaudeArgsOptions): string {
  const parts = [PROTOCOL_SYSTEM_PROMPT];
  if (opts.mcpConfigPath) parts.push(MCP_PROTOCOL_ADDENDUM);
  return parts.join('\n');
}

interface ClaudeArgsOptions {
  permissionMode?: string;
  extraArgs?: string[];
  model?: string;
  effort?: string;
  sessionId?: string;
  resume?: boolean;
  fileEvents?: boolean;
  mcpConfigPath?: string | null;
  allowedTools?: string[];
  additionalDirectories?: string[];
  permissionPromptTool?: string;
  extraAllowedTools?: string[];
}

function appendMcpConfig(args: string[], opts: ClaudeArgsOptions): void {
  if (!opts.mcpConfigPath) return;
  args.push('--mcp-config', opts.mcpConfigPath);
  args.push('--allowedTools', [...ALLOWED_MCP_TOOLS, ...(opts.extraAllowedTools ?? [])].join(','));
  if (opts.permissionPromptTool) args.push('--permission-prompt-tool', opts.permissionPromptTool);
}

// TECHDEBT: `claude` refuses `--session-id` on an id that already has a transcript —
// exit 1 with no stream event, which reads to the harness as a process that died for
// no reason. A launch carries `--session-id` or `--resume`, never both.
function appendSessionFlags(args: string[], opts: ClaudeArgsOptions): void {
  if (!opts.sessionId) return;
  if (opts.resume) args.push('--resume', opts.sessionId);
  else args.push('--session-id', opts.sessionId);
}

// TECHDEBT: `--settings` has no array form, so the file-events and permission fragments
// must share one JSON object. Their top-level keys are disjoint, so the merge is lossless.
function collectSettings(opts: ClaudeArgsOptions): string | null {
  const settings: Record<string, unknown> = {};
  if (opts.fileEvents) Object.assign(settings, FILE_EVENTS_SETTINGS);
  const permissions: Record<string, unknown> = {};
  if (opts.allowedTools?.length) permissions.allow = opts.allowedTools;
  if (opts.additionalDirectories?.length) permissions.additionalDirectories = opts.additionalDirectories;
  if (Object.keys(permissions).length > 0) settings.permissions = permissions;
  return Object.keys(settings).length > 0 ? JSON.stringify(settings) : null;
}

export function buildResumeMessage(): string {
  return 'You were resumed after a server restart. Continue the task from where you left off.';
}

export const STREAM_TRANSPORT_ARGS: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
];

export function buildClaudeStreamArgs(opts: ClaudeArgsOptions = {}): string[] {
  const args: string[] = [...STREAM_TRANSPORT_ARGS, '--append-system-prompt', protocolPrompt(opts)];
  appendSessionFlags(args, opts);
  const settings = collectSettings(opts);
  if (settings) args.push('--settings', settings);
  appendMcpConfig(args, opts);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

export function buildInitialMessage(task: Task): string {
  return task.prompt;
}
