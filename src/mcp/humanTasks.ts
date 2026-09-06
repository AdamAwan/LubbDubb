import type { HumanTaskInput } from '../types.js';

// → docs/spec/11-mcp-tools.md

const MAX_TITLE_LENGTH = 160;
const MAX_DETAIL_LENGTH = 2000;

export function validateHumanTask(args: unknown): { ok: true; input: HumanTaskInput } | { ok: false; error: string } {
  const raw = (args ?? {}) as Record<string, unknown>;

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title.length === 0) return { ok: false, error: 'title is required — say in one line what a person must do.' };
  if (title.includes('\n'))
    return {
      ok: false,
      error: 'title must be one line — an operator scans it in a list. Put the instructions in detail.',
    };
  if (title.length > MAX_TITLE_LENGTH)
    return {
      ok: false,
      error: `title must be at most ${MAX_TITLE_LENGTH} characters — it is a headline. Put the rest in detail.`,
    };

  if (raw.detail !== undefined && typeof raw.detail !== 'string')
    return { ok: false, error: 'detail must be a string of markdown, or omitted.' };
  const detail = typeof raw.detail === 'string' && raw.detail.trim().length > 0 ? raw.detail.trim() : null;
  if (detail !== null && detail.length > MAX_DETAIL_LENGTH)
    return { ok: false, error: `detail must be at most ${MAX_DETAIL_LENGTH} characters.` };

  return { ok: true, input: { title, detail } };
}
