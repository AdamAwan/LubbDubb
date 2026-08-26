import { DONE_SENTINEL, extractWaitingReason, stripSentinels } from './sentinels.js';

/**
 * Turns the content blocks of a stream-JSON message into clean, labelled display
 * text for the cockpit transcript. This is the legibility seam: the raw protocol
 * carries interleaved assistant prose, tool calls, and tool results with no
 * visual structure and no control-character hygiene, so we normalise them here
 * into a scannable transcript — reasoning as plain text, tool activity on its own
 * labelled lines, tool output sanitised and truncated.
 *
 * Kept as pure functions (no session state) so the formatting can be unit-tested
 * directly, matching the repo's "logic behind a seam" pattern.
 */
export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  /** tool_result payload: a string, an array of text blocks, or a nested object. */
  content?: unknown;
  is_error?: boolean;
  /**
   * When this block was written, ISO-8601. Display only — it dates the labelled
   * lines so a reader can tell a run that is working from one that stopped an hour
   * ago. The PTY path fills it from the session file's own `timestamp`, which is
   * the whole reason it is per-block: a restored agent re-renders its entire
   * history in one pass, and stamping that with the clock would date an hour of
   * finished work to this second — an agent that has been idle since lunch and one
   * still working would then read identically.
   */
  at?: string;
}

/**
 * Synthetic block type for a message *sent to* the agent — a human answer, or one
 * the harness injected. The wire protocol has no such block (stream mode only ever
 * renders what comes back), but the session-file transcript carries both halves of
 * the conversation and the drawer should show what you sent.
 */
export const HUMAN_BLOCK = 'human';

/** Tool output longer than this many lines is truncated with a remaining-lines marker. */
export const MAX_RESULT_LINES = 200;
/** Cap on a one-line tool-input summary before it's ellipsised. */
const MAX_SUMMARY_LEN = 140;

// SGR colours — xterm.js in the drawer renders these; the compact fleet-card
// tail strips them (see Hub.updateTail) so they never show as literal escapes.
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * `[HH:MM:SS]` for a block's time, or '' when it has none. Local time, because the
 * reader is the operator watching the fleet on this machine; seconds because the
 * gap that matters between two tool calls is often smaller than a minute.
 */
function stamp(at: string | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `[${d.toTimeString().slice(0, 8)}]`;
}

/** Raw concatenation of assistant text blocks (sentinels intact) for status detection. */
export function assistantText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/**
 * Format a message's content blocks into display text. Returns '' when nothing is
 * renderable.
 *
 * `at` dates every block that does not date itself — the stream runtime's blocks
 * arrive as they happen, so one reading of the clock covers the message; the PTY
 * runtime stamps each block from the session file instead (see {@link ContentBlock.at}).
 * Omitted, nothing is stamped, which is what keeps the function pure and testable.
 */
export function renderBlocks(blocks: ContentBlock[], at?: string): string {
  let out = '';
  for (const b of blocks) {
    const when = stamp(b.at ?? at);
    if (b.type === 'text') {
      const raw = b.text ?? '';
      const text = stripSentinels(raw);
      // Tool blocks close with a single newline, so prose following one would sit
      // flush against the last line of a result. Give it its own paragraph.
      if (text && out && !out.endsWith('\n\n')) out += '\n';
      out += text;
      out += sentinelMarkers(raw, when);
    } else if (b.type === 'tool_use') {
      out += renderToolUse(b, when);
    } else if (b.type === 'tool_result') {
      out += renderToolResult(b, when);
    } else if (b.type === HUMAN_BLOCK) {
      out += renderHuman(b, when);
    }
  }
  return out;
}

/**
 * The record that a status sentinel was **in** this block — the line that stands
 * where the token was stripped out.
 *
 * A sentinel is removed so the protocol never leaks into the reading, and for a
 * long time that left nothing at all: a turn announcing `done` and a turn that
 * simply stopped were byte-identical on the glass. That is not a cosmetic gap. An
 * operator who cannot see the announcement asks the agent whether it forgot to
 * finish; the agent, which can only consult its own memory of the turn, answers
 * that it did not and prints the token again — stripped again. Neither party can
 * reach the one thing that would settle it, and the transcript that should be the
 * record holds no evidence either way.
 *
 * Written from the **same bytes with the same helpers** {@link StreamJsonSession}
 * judges the turn with, so the marker can never claim a sentinel the runtime did
 * not see, nor stay silent about one it did. A `flag` gets no marker: it carries no
 * status meaning and already surfaces as its own artifact in the cockpit, so it is
 * the one sentinel whose disappearance from the text loses nothing.
 *
 * A block quoting the protocol while *explaining* it therefore marks too — which is
 * correct, because detection reads that block the same way and the transcript's job
 * here is to show what the runtime saw, not what the agent meant.
 */
function sentinelMarkers(raw: string, when: string): string {
  let out = '';
  if (raw.includes(DONE_SENTINEL)) out += `\n${prefix(when)}${GREEN}✓ announced done${RESET}\n`;
  const reason = extractWaitingReason(raw);
  if (reason !== null) {
    const said = reason ? ` ${DIM}${reason}${RESET}` : '';
    out += `\n${prefix(when)}${CYAN}⏸ asked for a person${RESET}${said}\n`;
  }
  return out;
}

/** A message sent *to* the agent, labelled so it reads as a turn rather than agent output. */
function renderHuman(b: ContentBlock, when: string): string {
  const text = sanitise(stripSentinels(b.text ?? '')).trim();
  if (!text) return '';
  const indented = text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  return `\n${prefix(when)}${GREEN}▸ sent${RESET}\n${indented}\n`;
}

function renderToolUse(b: ContentBlock, when: string): string {
  const name = b.name ?? 'tool';
  const summary = summariseInput(b.input);
  const label = `${prefix(when)}${CYAN}⚙ ${name}${RESET}`;
  return `\n${label}${summary ? ` ${DIM}${summary}${RESET}` : ''}\n`;
}

/**
 * A stamp ahead of a label, or nothing. The trailing space is part of it, so an
 * unstamped line is byte-for-byte what it was before stamps existed.
 */
function prefix(when: string): string {
  return when ? `${DIM}${when}${RESET} ` : '';
}

function renderToolResult(b: ContentBlock, when: string): string {
  const body = sanitise(extractResultText(b.content));
  const { text, hidden } = truncateLines(body, MAX_RESULT_LINES);
  // Pre-truncation total: the cockpit folds this into the collapsed summary, and the
  // server is the only side that still knows what was cut.
  const total = body === '' ? 0 : body.split('\n').length;
  const count = total > 1 ? `${DIM} · ${total} lines${RESET}` : '';
  // The finish time goes *after* the label rather than in front of it, and that is
  // load-bearing twice over: the cockpit finds a result by `^  ↳`, and it folds
  // everything past the label into the collapsed summary — so a call and the moment
  // it returned end up on one line, which is the reading that answers "is this still
  // going". In front, it would break the match and be dropped by the fold.
  const done = when ? `${DIM} ${when}${RESET}` : '';
  const label = b.is_error ? `${RED}  ↳ error${RESET}${done}${count}` : `${GRAY}  ↳ result${RESET}${done}${count}`;
  const indented = text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  const more = hidden > 0 ? `\n  ${DIM}… (+${hidden} more lines)${RESET}` : '';
  return `\n${label}\n${indented}${more}\n`;
}

/** Reduce a tool's input to a single readable line: prefer the salient field, else compact JSON. */
function summariseInput(input: unknown): string {
  let raw: string;
  if (typeof input === 'string') {
    raw = input;
  } else if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const salient = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query;
    raw = typeof salient === 'string' ? salient : JSON.stringify(o);
  } else {
    return '';
  }
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_SUMMARY_LEN ? `${oneLine.slice(0, MAX_SUMMARY_LEN - 1)}…` : oneLine;
}

/** Pull display text out of the many shapes a tool_result `content` can take. */
function extractResultText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return JSON.stringify(content);
}

/** Remove ANSI escape sequences (CSI/SGR and the shorter two-byte escapes). */
export function stripAnsi(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
  );
}

/** Strip ANSI escape sequences and C0 control chars (keeping tab/newline) so output can't corrupt the view. */
function sanitise(s: string): string {
  return (
    stripAnsi(s)
      // stray carriage returns (xterm converts \n itself)
      .replace(/\r/g, '')
      // remaining C0 controls except \t (\x09) and \n (\x0a)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

/** Keep the first `max` lines; report how many were dropped. */
function truncateLines(s: string, max: number): { text: string; hidden: number } {
  const lines = s.split('\n');
  if (lines.length <= max) return { text: s, hidden: 0 };
  return { text: lines.slice(0, max).join('\n'), hidden: lines.length - max };
}
