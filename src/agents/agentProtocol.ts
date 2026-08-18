import type { Task } from '../types.js';
import { STATUS_LINE_SETTINGS } from './statusLine.js';
import { FILE_EVENTS_SETTINGS } from './fileEvents.js';
import { ALLOWED_MCP_TOOLS } from '../mcp/names.js';
import { DONE_SENTINEL } from './sentinels.js';

/**
 * How a real Claude Code session is made to speak the harness's PTY protocol.
 *
 * The PtySession detects two sentinels — a "waiting" one (needs a human) and a
 * "done" one (finished). A live `claude` REPL emits neither on its own, so we
 * inject these instructions as an appended system prompt. The agent then
 * *announces* its own state instead of us guessing it from idle output, which is
 * the reliable way to read status out of an interactive model session.
 *
 * Tool-permission prompts (a separate CLI concern, not something the model
 * prints) are handled by `--permission-mode`, not by scraping output.
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
  'Do not print either sentinel for any other reason. Keep working autonomously between them.',
].join('\n');

/**
 * Appended when the launch carries the MCP tool channel (issue #108).
 *
 * The sentinels are **not** withdrawn here, and that is the design, not caution.
 * They are the degradation floor: the tool channel can be absent (no config, a
 * refused socket, a `claude` that ignores the server) and an agent must still be
 * able to park and finish, which only stdout guarantees. So the prompt states a
 * preference — richer channel first — and the *same* park transition backs both,
 * so an agent that does both, or neither-but-one, is never in a wrong state.
 *
 * `plan_submit` is stated as replacing the `.lubbdubb/plan.json` write; that file
 * path stays wired and stays documented in the planner's own prompt template, so
 * a planner that never sees the tool behaves exactly as it does today.
 *
 * This is also the *only* place several of these tools are named. A tool an agent
 * has to decide to call, and that no dispatch prompt mentions at its point of use,
 * is discoverable from `tools/list` alone — which in practice means an agent shells
 * out to `gh`/`az` instead. `test/mcpChannel.test.ts` classifies every entry of
 * `MCP_TOOL_NAMES` as named here or named at its point of use, so a new tool cannot
 * be added without that decision being made.
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
  '- world_read(kind, ref) instead of shelling out to `gh`/`az` to look up a pull request or issue.',
  "  It returns the harness's own view — CI status, review comments, merge state, an issue",
  '  body and its plan graph — from the same snapshot the dispatcher decided on, whichever provider',
  '  is configured. Call it with no ref to read the item you were dispatched for.',
  '- open_pr(summary, type, scope, body) instead of shelling out to `gh`/`az` to open the pull request for',
  '  the work you were dispatched to do. The branch and the base come from your own origin, never from an',
  '  argument — so a part stacked on another part targets the rung beneath it rather than the default',
  '  branch — and the title convention and the issue reference are written for you. Whether the pull',
  '  request *closes* its issue is still yours to say, in the body.',
  '- report_finding(kind, summary, ref) when you notice something that is not your task: a duplicate,',
  '  work blocked on something outside your reach, an unrelated problem. It reaches an operator instead',
  '  of being buried in a PR comment. It queues no work and dispatches nobody — report it and carry on',
  '  with your own task rather than going to fix it.',
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
 * The reminder a *terminal* tool folds into its success response — the tools whose
 * call is the whole of what an agent was dispatched to do (`assess_issue`,
 * `conclude_work`, `conclude_part`).
 *
 * The sentinel is stated once, in the system prompt, thousands of tokens before the
 * moment it matters, and these tools' responses read as the end of the job
 * ("Recorded. The harness will schedule nothing further"). So an agent that records
 * its verdict, narrates it and stops has done everything asked of it and still ends
 * its turn with no sentinel in it — which {@link StreamJsonSession} can only read as
 * a park, the done/waiting decision having no third branch. Saying it here puts the
 * instruction at the point of use instead of resting on recall.
 *
 * It does **not** make the call imply done: an agent may have more to do after one,
 * so this states the condition rather than announcing the end.
 */
export const DONE_REMINDER =
  'Nothing else is needed from this call. When you have finished everything your task asked for, print ' +
  DONE_SENTINEL +
  ' on its own line as the last thing you output: the harness has no other signal that you are done, and a ' +
  'turn ending without it parks you as waiting for a human who has nothing to answer.';

/** The system prompt for a launch: the protocol, plus the tool addendum when tools are wired. */
function protocolPrompt(opts: ClaudeArgsOptions): string {
  return opts.mcpConfigPath ? PROTOCOL_SYSTEM_PROMPT + '\n' + MCP_PROTOCOL_ADDENDUM : PROTOCOL_SYSTEM_PROMPT;
}

interface ClaudeArgsOptions {
  /** Passed to `--permission-mode` (e.g. "acceptEdits", "bypassPermissions"). Omitted if empty. */
  permissionMode?: string;
  /** Any additional operator-supplied args appended after ours. */
  extraArgs?: string[];
  /**
   * The model this launch runs on (`--model`), resolved from the operator's
   * `agentModels` policy at *dispatch* and carried on the task (issue #321).
   * Unset leaves the flag off entirely, which is what a deployment configuring no
   * policy gets — argv identical to before the option existed.
   *
   * Pushed **before** {@link extraArgs} for the reason `--allowedTools` is: an
   * operator's `claudeArgs` are appended last and still have the last word.
   * Never validated here — only the installed `claude` knows the valid set, so a
   * bad alias fails at spawn as a failed agent, not at boot.
   */
  model?: string;
  /**
   * The reasoning depth this launch runs at (`--effort`), from the same profile
   * as {@link model} and carried the same way. Unset leaves the flag off, and the
   * CLI applies its own default — which is the top of the ladder, so "unset" is
   * the expensive end rather than the middle.
   *
   * Pushed before {@link extraArgs} for {@link model}'s reason, and unvalidated
   * for it too: the levels a model accepts are the installed CLI's business, and
   * the smaller models refuse the flag outright.
   */
  effort?: string;
  /**
   * The session id to run under. Chosen up front (`--session-id`) so we *own* the
   * id and can re-attach to this exact conversation after a restart — no scraping
   * an id out of the terminal. Both real runtimes pass one; only the `raw` runtime,
   * which speaks no protocol at all, omits it.
   */
  sessionId?: string;
  /**
   * Re-attach to {@link sessionId} (`--resume <id>`) instead of starting a fresh
   * session. Used only when an orphaned agent is restored.
   */
  resume?: boolean;
  /**
   * Wire the status-line capture in (`--settings`), so account rate limits can
   * be read from the payload the TUI feeds it. PTY launches only — the status
   * line never renders headless, so it would be dead weight on stream args.
   */
  statusLine?: boolean;
  /**
   * Wire the file-events `PostToolUse` hook in (`--settings`), so files an agent
   * writes surface as artifacts without the agent's prompt knowing the flag
   * protocol. Both runtimes — hooks fire in headless stream mode too.
   */
  fileEvents?: boolean;
  /**
   * Path to this launch's `--mcp-config`, wiring the harness's tool channel in
   * (issue #108). Per-agent, because the file carries the credential that gives
   * the launch its identity. Unset (or null) leaves the agent on the sentinels
   * alone, which is the fail-open floor — never a broken state.
   */
  mcpConfigPath?: string | null;
  /**
   * Operator-configured tool allow rules (`agentAllowedTools`), e.g.
   * `Bash(npm:*)` / `Bash(git:*)` — the mechanical validate/commit/push commands
   * a headless agent must run unattended (issue #130). They ride in a
   * `permissions.allow` fragment inside `--settings`, **not** in `--allowedTools`:
   * that flag carries the `mcp__lubbdubb__*` grants, and letting a Bash rule share
   * it is exactly the drift `src/mcp/names.ts` exists to prevent — an operator
   * adjusting Bash access could silently drop the MCP grants. Two different flags,
   * two different concerns. `acceptEdits` still governs everything not listed here;
   * anything outside the list falls through to the permission backstop (#130
   * phase B) rather than hanging.
   */
  allowedTools?: string[];
  /**
   * Directories outside the agent's cwd it may read (`permissions.additionalDirectories`
   * in the same `--settings` fragment as {@link allowedTools}). One entry today:
   * the attachment root (issue #249), where a blueprint's images live — outside
   * every worktree, so without this grant the path in the agent's prompt is one it
   * cannot open.
   *
   * In `--settings` rather than `--allowedTools` for that flag's stated reason: an
   * operator adjusting one must not be able to clobber the MCP grants.
   */
  additionalDirectories?: string[];
  /**
   * The qualified MCP tool name for `--permission-prompt-tool` — the permission
   * backstop (issue #130 phase B). When a tool call is covered by neither the
   * allow-list nor the permission mode, Claude Code calls this tool instead of
   * denying, and it routes the request to the operator. Only takes effect when
   * {@link mcpConfigPath} is also set, since the tool lives on the MCP server.
   */
  permissionPromptTool?: string;
}

/**
 * Append the MCP tool channel to a launch, when one was minted for it.
 *
 * Two flags, both load-bearing, both verified empirically against `claude`
 * 2.1.220 rather than assumed:
 *
 * - `--mcp-config` is **additive**: launched alongside a target repo's own
 *   `.mcp.json`, both servers appear (`mcp_servers: [{theirs}, {ours}]`). That
 *   is why `--strict-mcp-config` is deliberately *not* passed — it would suppress
 *   the user's own servers in their own checkout. Same coexistence property the
 *   `--settings` hook merge has.
 * - `--allowedTools` is **required**, not belt-and-braces. An `--mcp-config`
 *   server connects with no approval step (a project `.mcp.json` server instead
 *   sits at `pending`), but its tool *calls* are still permission-gated and
 *   `--permission-mode acceptEdits` does not cover them: every call comes back
 *   `"Claude requested permissions to use mcp__lubbdubb__…, but you haven't
 *   granted it yet."` with no human at the prompt to grant it. The flag is
 *   additive rather than restrictive — an agent launched with it still uses
 *   Bash/Write normally — so this grants our tools and nothing else changes.
 *
 * Operator `claudeArgs` are appended *after* these, so an explicit
 * `--allowedTools` there still has the last word.
 */
function appendMcpConfig(args: string[], opts: ClaudeArgsOptions): void {
  if (!opts.mcpConfigPath) return;
  args.push('--mcp-config', opts.mcpConfigPath);
  args.push('--allowedTools', ALLOWED_MCP_TOOLS.join(','));
  // The permission backstop lives on this same server, so it's only wirable when
  // the channel is (issue #130 phase B). Claude Code then calls it — rather than
  // denying — for any tool the allow-list and permission mode don't resolve.
  if (opts.permissionPromptTool) args.push('--permission-prompt-tool', opts.permissionPromptTool);
}

/**
 * Pin the conversation this launch runs as — the one piece of argv that makes an
 * agent re-attachable, and identical on both real runtimes (issue #318).
 *
 * `--session-id` (mint this id) and `--resume` (re-open it) are **mutually
 * exclusive**, and not merely as a style rule: `claude` refuses `--session-id` on
 * an id that already has a transcript, exiting 1 with a plain-stderr
 * `Session ID … is already in use.` and no stream event at all — so a relaunch
 * that carried the stored id down the mint arm would look, to the harness, like a
 * process that died for no reason. A resume must never also try to mint.
 */
function appendSessionFlags(args: string[], opts: ClaudeArgsOptions): void {
  if (!opts.sessionId) return;
  if (opts.resume) args.push('--resume', opts.sessionId);
  else args.push('--session-id', opts.sessionId);
}

/** Build the argv for launching an interactive (PTY) `claude` agent that speaks the protocol. */
export function buildClaudeArgs(opts: ClaudeArgsOptions = {}): string[] {
  // Re-append the protocol on every launch, including resume: `--resume` replays
  // the conversation but does not retain the original invocation's appended
  // system prompt, so waiting/done detection would break without this.
  const args: string[] = ['--append-system-prompt', protocolPrompt(opts)];
  appendSessionFlags(args, opts);
  // Merge every requested settings fragment into a single `--settings` — the flag
  // has no array form, so status-line + file-events must share one JSON object.
  const settings = collectSettings(opts);
  if (settings) args.push('--settings', settings);
  appendMcpConfig(args, opts);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/**
 * Combine the enabled `--settings` fragments into one JSON string, or null if
 * none. The flag has no array form, so status-line, file-events and the
 * permission allow-list must share one JSON object; their top-level keys
 * (`statusLine` / `hooks` / `permissions`) are disjoint, so a plain merge is
 * lossless. Used by **both** runtimes (the stream launch just never asks for the
 * PTY-only status line), so an operator allow-list reaches headless agents too.
 */
function collectSettings(opts: ClaudeArgsOptions): string | null {
  const settings: Record<string, unknown> = {};
  if (opts.statusLine) Object.assign(settings, STATUS_LINE_SETTINGS);
  if (opts.fileEvents) Object.assign(settings, FILE_EVENTS_SETTINGS);
  // One `permissions` object, however many of its halves were asked for: the
  // allow-list and the extra readable directories are separate concerns that share
  // a key, and writing it twice would drop whichever was written first.
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
 * bidirectional stream-JSON. No TUI, structured events, stays alive across turns
 * so the waiting/answer loop works. This is the production agent launch.
 *
 * It carries the same `--session-id` / `--resume` pair as the PTY launch, verified
 * against `claude` 2.1.223 rather than assumed (issue #318): headless honours a
 * pinned id (every event echoes it, and the transcript lands under
 * `~/.claude/projects/<slug>/<id>.jsonl`), `--resume` re-opens *that* file and
 * appends to it rather than forking a new id, and a resumed headless session stays
 * alive across turns exactly as a fresh one does. Crucially it also **replays
 * nothing**: a resume emits `system`/`init`, the assistant turn for the new input,
 * then `result` — no prior-turn events — so {@link StreamJsonSession} needs no
 * swallow and the drawer's transcript continues instead of repeating.
 */
export function buildClaudeStreamArgs(opts: ClaudeArgsOptions = {}): string[] {
  const args: string[] = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose', // required for stream-json output
    '--append-system-prompt',
    protocolPrompt(opts),
  ];
  appendSessionFlags(args, opts);
  // The status line never renders headless, but PostToolUse hooks and permission
  // rules do apply — so file-events capture and the operator allow-list are wired
  // here too (unlike the PTY-only status line, which collectSettings skips when
  // `statusLine` isn't requested).
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
