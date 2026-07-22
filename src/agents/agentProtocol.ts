import type { Task } from '../types.js';
import { STATUS_LINE_SETTINGS } from './statusLine.js';

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

export interface ClaudeArgsOptions {
  /** Passed to `--permission-mode` (e.g. "acceptEdits", "bypassPermissions"). Omitted if empty. */
  permissionMode?: string;
  /** Any additional operator-supplied args appended after ours. */
  extraArgs?: string[];
  /**
   * The session id to run under. Chosen up front (`--session-id`) so we *own* the
   * id and can re-attach to this exact conversation after a restart — no scraping
   * an id out of the terminal. Omitted for runtimes that don't support resume.
   */
  sessionId?: string;
  /**
   * Re-attach to {@link sessionId} (`--resume <id>`) instead of starting a fresh
   * session. Used only on boot resume of an orphaned agent.
   */
  resume?: boolean;
  /**
   * Wire the status-line capture in (`--settings`), so account rate limits can
   * be read from the payload the TUI feeds it. PTY launches only — the status
   * line never renders headless, so it would be dead weight on stream args.
   */
  statusLine?: boolean;
}

/** Build the argv for launching an interactive (PTY) `claude` agent that speaks the protocol. */
export function buildClaudeArgs(opts: ClaudeArgsOptions = {}): string[] {
  // Re-append the protocol on every launch, including resume: `--resume` replays
  // the conversation but does not retain the original invocation's appended
  // system prompt, so waiting/done detection would break without this.
  const args: string[] = ['--append-system-prompt', PROTOCOL_SYSTEM_PROMPT];
  if (opts.sessionId) {
    // `--session-id` (pick a new id) and `--resume` (re-open that id) are mutually
    // exclusive — a resume must not also try to mint the id.
    if (opts.resume) args.push('--resume', opts.sessionId);
    else args.push('--session-id', opts.sessionId);
  }
  if (opts.statusLine) args.push('--settings', STATUS_LINE_SETTINGS);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
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
    PROTOCOL_SYSTEM_PROMPT,
  ];
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/** The first user message typed into a fresh agent session: the task itself. */
export function buildInitialMessage(task: Task): string {
  return task.prompt;
}
