// → docs/spec/11-mcp-tools.md

export const MAX_NOTE_LENGTH = 200;

export function normaliseNote(
  value: unknown,
): { ok: true; note: string; trimmed: boolean } | { ok: false; error: string } {
  const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!raw) {
    return {
      ok: false,
      error: 'note is required: one line saying what you are working on right now, in plain words.',
    };
  }
  if (raw.length <= MAX_NOTE_LENGTH) return { ok: true, note: raw, trimmed: false };
  return { ok: true, note: raw.slice(0, MAX_NOTE_LENGTH - 1).trimEnd() + '…', trimmed: true };
}
