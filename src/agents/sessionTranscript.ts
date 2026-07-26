import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_BLOCK, renderBlocks, type ContentBlock } from './streamTranscript.js';

/**
 * The PTY-mode legibility seam. Claude Code writes every session's conversation to
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` as structured records —
 * the same content-block shapes stream mode receives over its pipe — so the
 * transcript for an interactive agent can simply be *read* rather than
 * reconstructed by screen-scraping its TUI.
 *
 * That matters because the screen is the wrong source: it carries the slash-command
 * dropdown, `Tip:` hints, `(ctrl+o to expand)` markers and input-box rules as
 * content, and it has already hard-wrapped prose at the emulator's column width.
 * No amount of chrome blacklisting recovers the logical lines. The session file has
 * none of those problems, so PTY and stream mode converge on one renderer
 * ({@link renderBlocks}) and the TUI becomes purely an input device.
 *
 * Entries are written per content block as each completes, so the tail is live at
 * block granularity (a few seconds), not token-by-token.
 */

/** Where Claude Code keeps per-project session transcripts. */
export function defaultSessionRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Envelope tags Claude Code wraps local slash-command traffic in. `exitOnDone`
 * writes `/exit` to end the REPL, which lands here as a caveat + command-name +
 * stdout trio — exactly the terminal noise this module exists to eliminate, so it
 * is dropped rather than rendered.
 */
const LOCAL_COMMAND_TAGS = [
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
];

function isLocalCommandEnvelope(text: string): boolean {
  const t = text.trimStart();
  return LOCAL_COMMAND_TAGS.some((tag) => t.startsWith(`<${tag}>`));
}

interface ParsedBatch {
  /** In-order content blocks, ready for {@link renderBlocks}. */
  blocks: ContentBlock[];
  /**
   * Raw assistant text with sentinels intact, for status detection. Deliberately
   * excludes human/injected messages: a task prompt that *describes* the protocol
   * (they exist) would otherwise mark the agent done the moment it was sent.
   */
  assistantText: string;
  /**
   * How many human/injected messages the session accepted in this batch. The
   * initial-submit boot race watches this: a `user` entry appearing is proof the
   * pasted prompt was actually submitted.
   */
  userEntries: number;
}

/** Parse raw JSONL lines into renderable blocks. Pure. */
export function parseSessionEntries(lines: string[]): ParsedBatch {
  const blocks: ContentBlock[] = [];
  let assistantText = '';
  let userEntries = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a torn or unrecognised record is skipped, never fatal
    }
    // Sidechains are subagent conversations; the parent's `Task` tool_use already
    // marks that one ran, so interleaving its turns here would only confuse.
    if (entry.isMeta === true || entry.isSidechain === true) continue;
    const type = entry.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const message = entry.message as { content?: unknown } | undefined;
    if (!message) continue;
    const content = message.content;

    if (type === 'assistant') {
      if (!Array.isArray(content)) continue;
      for (const block of content as ContentBlock[]) {
        blocks.push(block);
        if (block.type === 'text' && typeof block.text === 'string') assistantText += block.text;
      }
      continue;
    }

    // `user` entries are either a message someone sent, or the tool results the
    // harness fed back in.
    if (typeof content === 'string') {
      if (isLocalCommandEnvelope(content)) continue;
      userEntries += 1;
      if (content.trim()) blocks.push({ type: HUMAN_BLOCK, text: content });
    } else if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) blocks.push(block);
    }
  }

  return { blocks, assistantText, userEntries };
}

/**
 * Find a session's transcript file. Globs `<root>/*` for `<sessionId>.jsonl`
 * rather than deriving the directory-name encoding from the cwd: the session id is
 * unique, and the glob keeps working if that encoding ever changes.
 */
export function locateSessionFile(root: string, sessionId: string): string | null {
  if (!sessionId || !existsSync(root)) return null;
  const name = `${sessionId}.jsonl`;
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface SessionTranscriptUpdate {
  /** Display text to append to the transcript (may be empty). */
  display: string;
  /** Raw assistant text for sentinel detection (may be empty). */
  assistantText: string;
  /** Human/injected messages accepted in this batch. */
  userEntries: number;
}

interface SessionTranscriptTailOptions {
  root: string;
  sessionId: string;
  /** How often to check the file for growth. */
  pollMs?: number;
  /**
   * Start from the end of an existing file instead of its beginning. Set on
   * resume: the file already holds the pre-restart turns, which are already
   * persisted, so replaying them would duplicate the transcript.
   */
  startAtEof?: boolean;
  onUpdate: (update: SessionTranscriptUpdate) => void;
  /** Surfaced rather than swallowed — a broken tail should be visible, not silent. */
  onError?: (err: Error) => void;
}

const DEFAULT_POLL_MS = 400;

/**
 * Tails one session's JSONL file, emitting rendered transcript text as records are
 * appended. Byte-offset based, with an undecoded remainder buffer so a record that
 * is only half-written when we read is held until its newline arrives.
 */
export class SessionTranscriptTail {
  private timer: ReturnType<typeof setInterval> | null = null;
  private file: string | null = null;
  private offset = 0;
  /** Bytes after the last complete newline — a partially-written record. */
  private remainder: Buffer = Buffer.alloc(0);
  private stopped = false;

  constructor(private readonly opts: SessionTranscriptTailOptions) {}

  /**
   * Whether the session file has actually been found. Callers treating this tail as
   * their primary source need it: until the file exists there is nothing to defer
   * to, so a fallback should act immediately rather than wait on a source that may
   * never speak.
   */
  located(): boolean {
    return this.file !== null;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const t = setInterval(() => this.poll(), this.opts.pollMs ?? DEFAULT_POLL_MS);
    t.unref?.();
    this.timer = t;
  }

  /** Read whatever has been appended right now. Used at exit so the final turn isn't lost. */
  drain(): void {
    if (!this.stopped) this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    try {
      this.read();
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private read(): void {
    if (!this.file) {
      // The file appears a beat after the process spawns, so keep looking.
      this.file = locateSessionFile(this.opts.root, this.opts.sessionId);
      if (!this.file) return;
      if (this.opts.startAtEof) this.offset = statSync(this.file).size;
    }

    // Size the read off the *open descriptor*, not the path: a live agent is
    // appending to this file, so a stat-then-open pair races (the file can grow,
    // be truncated, or be replaced in between) and a buffer sized from the stale
    // stat would be part-filled with zeros. Advancing by the bytes actually read
    // closes the rest of the gap.
    let chunk: Buffer;
    const fd = openSync(this.file, 'r');
    try {
      const size = fstatSync(fd).size;
      // Shrunk means the file was replaced under us; re-read from the top.
      if (size < this.offset) {
        this.offset = 0;
        this.remainder = Buffer.alloc(0);
      }
      if (size === this.offset) return;
      const pending = Buffer.alloc(size - this.offset);
      const bytes = readSync(fd, pending, 0, pending.length, this.offset);
      this.offset += bytes;
      chunk = pending.subarray(0, bytes);
    } finally {
      closeSync(fd);
    }

    let buf = Buffer.concat([this.remainder, chunk]);
    const lines: string[] = [];
    for (;;) {
      // Safe to split on raw 0x0A: it never occurs inside a UTF-8 multibyte sequence.
      const idx = buf.indexOf(0x0a);
      if (idx === -1) break;
      lines.push(buf.subarray(0, idx).toString('utf8'));
      buf = buf.subarray(idx + 1);
    }
    this.remainder = buf;
    if (!lines.length) return;

    const batch = parseSessionEntries(lines);
    const display = renderBlocks(batch.blocks);
    if (!display && !batch.assistantText && !batch.userEntries) return;
    this.opts.onUpdate({ display, assistantText: batch.assistantText, userEntries: batch.userEntries });
  }
}
