import { stripSentinels } from './sentinels.js';

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
}

/** Tool output longer than this many lines is truncated with a remaining-lines marker. */
export const MAX_RESULT_LINES = 12;
/** Cap on a one-line tool-input summary before it's ellipsised. */
const MAX_SUMMARY_LEN = 140;

// SGR colours — xterm.js in the drawer renders these; the compact fleet-card
// tail strips them (see Hub.updateTail) so they never show as literal escapes.
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Raw concatenation of assistant text blocks (sentinels intact) for status detection. */
export function assistantText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** Format a message's content blocks into display text. Returns '' when nothing is renderable. */
export function renderBlocks(blocks: ContentBlock[]): string {
  let out = '';
  for (const b of blocks) {
    if (b.type === 'text') {
      out += stripSentinels(b.text ?? '');
    } else if (b.type === 'tool_use') {
      out += renderToolUse(b);
    } else if (b.type === 'tool_result') {
      out += renderToolResult(b);
    }
  }
  return out;
}

function renderToolUse(b: ContentBlock): string {
  const name = b.name ?? 'tool';
  const summary = summariseInput(b.input);
  const label = `${CYAN}⚙ ${name}${RESET}`;
  return `\n${label}${summary ? ` ${DIM}${summary}${RESET}` : ''}\n`;
}

function renderToolResult(b: ContentBlock): string {
  const body = sanitise(extractResultText(b.content));
  const { text, hidden } = truncateLines(body, MAX_RESULT_LINES);
  const label = b.is_error ? `${RED}  ↳ error${RESET}` : `${GRAY}  ↳ result${RESET}`;
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
