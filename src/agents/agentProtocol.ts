import type { Task } from '../types.js';
import { FILE_EVENTS_SETTINGS } from './fileEvents.js';
import { ALLOWED_MCP_TOOLS } from '../mcp/names.js';
import { DONE_SENTINEL } from './sentinels.js';

/**
 * How a real Claude Code session is made to speak the harness's status protocol:
 * two sentinels — waiting and done — that `claude` emits only because this appended
 * system prompt asks for them. Tool-permission prompts are `--permission-mode`'s
 * business, never read out of output. → `docs/spec/10-agent-runtimes.md`
 */
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

/**
 * Appended when the launch carries the MCP tool channel. The sentinels are **not**
 * withdrawn — they are the degradation floor when the channel is absent, and the
 * same park transition backs both. This is also the *only* place several of these
 * tools are named; `test/mcpChannel.test.ts` classifies every entry of
 * `MCP_TOOL_NAMES` as named here or at its point of use.
 * → `docs/spec/11-mcp-tools.md`
 */
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

/**
 * The reminder a *terminal* tool folds into its success response (`assess_issue`,
 * `conclude_work`, `conclude_part`) — the sentinel restated at the point of use,
 * because a turn ending without one can only be read as a park. It states the
 * condition rather than announcing the end: the call does not imply done.
 */
export const DONE_REMINDER =
  'Nothing else is needed from this call. When you have finished everything your task asked for, print ' +
  DONE_SENTINEL +
  ' on its own line as the last thing you output: the harness has no other signal that you are done, and a ' +
  'turn ending without it parks you as waiting for a human who has nothing to answer.';

/**
 * What the harness types into an agent whose turn ended with **no** sentinel — the
 * unannounced stop. It states all three exits rather than guessing one: an agent
 * told "carry on" that had finished invents work, and one told "you are done" that
 * had not abandons it.
 */
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

/** How much of an agent's last words the park reason quotes before it elides the front. */
const LAST_WORDS_MAX = 240;

/**
 * The park reason for an unannounced stop, once the nudges are spent. It quotes the
 * **end** of the turn, which is where the diagnosis always is. The blank line is
 * load-bearing: the cockpit's escalation card splits the prompt on the first one
 * into a headline and a body.
 */
export function stallReason(lastWords: string): string {
  const head = 'Stopped without finishing, and without saying why — it may only need telling to carry on.';
  const tail = lastWords.replace(/\s+/g, ' ').trim();
  if (!tail) return head;
  const quoted = tail.length > LAST_WORDS_MAX ? '…' + tail.slice(tail.length - LAST_WORDS_MAX) : tail;
  return `${head}\n\nIt last said: "${quoted}"`;
}

/**
 * The park reason for an agent that has produced no output at all for
 * `agentSilenceParkMs`. No last words to quote, so it states the span. The blank
 * line is load-bearing for {@link stallReason}'s reason.
 */
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

/**
 * The system prompt for a launch: the protocol, plus the tool addendum when tools
 * are wired. Appended, never interpolated, and omitted entirely when it does not
 * apply. Nothing fleet-wide is injected here — a keyed obstacle rides the task
 * prompt of the dispatches it is about (`docs/spec/27-obstacles.md#delivery`).
 */
function protocolPrompt(opts: ClaudeArgsOptions): string {
  const parts = [PROTOCOL_SYSTEM_PROMPT];
  if (opts.mcpConfigPath) parts.push(MCP_PROTOCOL_ADDENDUM);
  return parts.join('\n');
}

interface ClaudeArgsOptions {
  /** Passed to `--permission-mode` (e.g. "acceptEdits", "bypassPermissions"). Omitted if empty. */
  permissionMode?: string;
  /** Any additional operator-supplied args appended after ours. */
  extraArgs?: string[];
  /** The model this launch runs on (`--model`), resolved at dispatch. Pushed before {@link extraArgs} so an operator's `claudeArgs` has the last word. Unset leaves the flag off; unvalidated. */
  model?: string;
  /** The reasoning depth (`--effort`). Unset leaves the flag off and the CLI defaults to the top of the ladder — the expensive end. Unvalidated. */
  effort?: string;
  /** The session id to run under, chosen up front so the harness can re-attach after a restart. Only the `raw` runtime omits it. */
  sessionId?: string;
  /** Re-attach to {@link sessionId} (`--resume <id>`) instead of starting fresh. Used only when an orphaned agent is restored. */
  resume?: boolean;
  /** Wire the file-events `PostToolUse` hook in (`--settings`), so written files surface as artifacts. */
  fileEvents?: boolean;
  /** Path to this launch's `--mcp-config`, per-agent since the file carries the launch's credential. Unset leaves the agent on the sentinels alone — the fail-open floor. */
  mcpConfigPath?: string | null;
  /**
   * Operator-configured tool allow rules (`agentAllowedTools`), e.g. `Bash(npm:*)`.
   * Ride in `permissions.allow` inside `--settings`, never in `--allowedTools` (which
   * carries the `mcp__lubbdubb__*` grants — sharing the flag would silently drop them
   * on an operator's Bash edit). Unlisted calls fall through to the permission backstop.
   */
  allowedTools?: string[];
  /** Directories outside the agent's cwd it may read, same `--settings` fragment as {@link allowedTools}, never `--allowedTools`. One entry today: the attachment root. */
  additionalDirectories?: string[];
  /** The qualified MCP tool name for `--permission-prompt-tool`, called instead of denying when neither the allow-list nor permission mode covers a call. Only takes effect alongside {@link mcpConfigPath}. */
  permissionPromptTool?: string;
  /** Permission rules for MCP servers beside the harness's own, on `--allowedTools` for {@link allowedTools}'s reason. Only meaningful alongside {@link mcpConfigPath}. */
  extraAllowedTools?: string[];
}

/**
 * Append the MCP tool channel to a launch, when one was minted for it. `--mcp-config`
 * is additive and coexists with a repo's own `.mcp.json` (so `--strict-mcp-config` is
 * deliberately not passed); `--allowedTools` is required, since the server connects
 * without approval but its calls are still permission-gated with no human to grant them.
 * → `docs/spec/11-mcp-tools.md#launch-flags`
 */
function appendMcpConfig(args: string[], opts: ClaudeArgsOptions): void {
  if (!opts.mcpConfigPath) return;
  args.push('--mcp-config', opts.mcpConfigPath);
  // Ours first, then whatever this dispatch brought. Additive in both directions.
  args.push('--allowedTools', [...ALLOWED_MCP_TOOLS, ...(opts.extraAllowedTools ?? [])].join(','));
  // The backstop lives on this same server, so it is only wirable when the channel is.
  if (opts.permissionPromptTool) args.push('--permission-prompt-tool', opts.permissionPromptTool);
}

/**
 * Pin the conversation this launch runs as — the one piece of argv that makes an
 * agent re-attachable. `--session-id` and `--resume` are **mutually exclusive**:
 * `claude` refuses `--session-id` on an id that already has a transcript, exiting 1
 * with no stream event, which reads to the harness as a process that died for no
 * reason. → `docs/spec/10-agent-runtimes.md#launch-arguments`
 */
function appendSessionFlags(args: string[], opts: ClaudeArgsOptions): void {
  if (!opts.sessionId) return;
  if (opts.resume) args.push('--resume', opts.sessionId);
  else args.push('--session-id', opts.sessionId);
}

/**
 * Combine the enabled `--settings` fragments into one JSON string, or null if
 * none. The flag has no array form, so file-events and the permission allow-list
 * must share one JSON object; their top-level keys (`hooks` / `permissions`) are
 * disjoint, so a plain merge is lossless.
 */
function collectSettings(opts: ClaudeArgsOptions): string | null {
  const settings: Record<string, unknown> = {};
  if (opts.fileEvents) Object.assign(settings, FILE_EVENTS_SETTINGS);
  // One `permissions` object however many halves were asked for: writing it twice
  // would drop whichever was written first.
  const permissions: Record<string, unknown> = {};
  if (opts.allowedTools?.length) permissions.allow = opts.allowedTools;
  if (opts.additionalDirectories?.length) permissions.additionalDirectories = opts.additionalDirectories;
  if (Object.keys(permissions).length > 0) settings.permissions = permissions;
  return Object.keys(settings).length > 0 ? JSON.stringify(settings) : null;
}

/**
 * The first message typed into a *resumed* agent that was mid-work (not parked on
 * a question) when the server went down. `--resume` re-opens the session idle and
 * awaiting input, so we nudge it to carry on. An agent that was waiting for a
 * human instead keeps its escalation and is answered normally.
 */
export function buildResumeMessage(): string {
  return 'You were resumed after a server restart. Continue the task from where you left off.';
}

/**
 * Build the argv for the unattended streaming runtime: headless print mode with
 * bidirectional stream-JSON, staying alive across turns so the waiting/answer loop
 * works. A resume re-opens the pinned id's transcript and **replays nothing**, so
 * {@link StreamJsonSession} needs no swallow.
 */
/**
 * The stream transport itself, with nothing about the fleet's protocol in it.
 * Exported because the local run (`src/localRun/`) speaks the same transport and
 * must **not** carry {@link PROTOCOL_SYSTEM_PROMPT} — it has no tools, no task and
 * nothing to conclude. One definition of the flags either way.
 */
export const STREAM_TRANSPORT_ARGS: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose', // required for stream-json output
];

export function buildClaudeStreamArgs(opts: ClaudeArgsOptions = {}): string[] {
  const args: string[] = [...STREAM_TRANSPORT_ARGS, '--append-system-prompt', protocolPrompt(opts)];
  appendSessionFlags(args, opts);
  // PostToolUse hooks and permission rules apply headless, so both are wired here.
  const settings = collectSettings(opts);
  if (settings) args.push('--settings', settings);
  appendMcpConfig(args, opts);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/** The first user message typed into a fresh agent session: the task itself. */
export function buildInitialMessage(task: Task): string {
  return task.prompt;
}
