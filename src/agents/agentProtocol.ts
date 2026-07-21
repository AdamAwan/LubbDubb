import type { Task } from '../types.js';

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
}

/** Build the argv for launching an interactive (PTY) `claude` agent that speaks the protocol. */
export function buildClaudeArgs(opts: ClaudeArgsOptions = {}): string[] {
  const args: string[] = ['--append-system-prompt', PROTOCOL_SYSTEM_PROMPT];
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
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
