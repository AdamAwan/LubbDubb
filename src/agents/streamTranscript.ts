import { DONE_SENTINEL, extractWaitingReason, stripSentinels } from './sentinels.js';

// → docs/spec/10-agent-runtimes.md

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  at?: string;
}

export const HUMAN_BLOCK = 'human';

export const MAX_RESULT_LINES = 200;
const MAX_SUMMARY_LEN = 140;

const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function stamp(at: string | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `[${d.toTimeString().slice(0, 8)}]`;
}

export function assistantText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

export function renderBlocks(blocks: ContentBlock[], at?: string): string {
  let out = '';
  for (const b of blocks) {
    const when = stamp(b.at ?? at);
    if (b.type === 'text') {
      const raw = b.text ?? '';
      const text = stripSentinels(raw);
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

function prefix(when: string): string {
  return when ? `${DIM}${when}${RESET} ` : '';
}

function renderToolResult(b: ContentBlock, when: string): string {
  const body = sanitise(extractResultText(b.content));
  const { text, hidden } = truncateLines(body, MAX_RESULT_LINES);
  const total = body === '' ? 0 : body.split('\n').length;
  const count = total > 1 ? `${DIM} · ${total} lines${RESET}` : '';
  const done = when ? `${DIM} ${when}${RESET}` : '';
  const label = b.is_error ? `${RED}  ↳ error${RESET}${done}${count}` : `${GRAY}  ↳ result${RESET}${done}${count}`;
  const indented = text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  const more = hidden > 0 ? `\n  ${DIM}… (+${hidden} more lines)${RESET}` : '';
  return `\n${label}\n${indented}${more}\n`;
}

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

export function stripAnsi(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
  );
}

function sanitise(s: string): string {
  return (
    stripAnsi(s)
      .replace(/\r/g, '')
      // remaining C0 controls except \t (\x09) and \n (\x0a)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

function truncateLines(s: string, max: number): { text: string; hidden: number } {
  const lines = s.split('\n');
  if (lines.length <= max) return { text: s, hidden: 0 };
  return { text: lines.slice(0, max).join('\n'), hidden: lines.length - max };
}
