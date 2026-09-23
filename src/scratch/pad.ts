// → docs/spec/11-mcp-tools.md#forks-on-the-pad

export const MAX_PAD_NOTE = 4000;

const MAX_PAD_TOPIC = 60;

export function padOriginFor(originRef: string | null): string | null {
  if (!originRef) return null;
  const match = /^(issue|pr):(\d+)(?::.+)?$/.exec(originRef);
  return match ? `${match[1]}:${match[2]}` : null;
}

export function goalOriginFor(originRef: string | null): string | null {
  const pad = padOriginFor(originRef);
  return pad?.startsWith('issue:') ? pad : null;
}

export function padWriteTarget(originRef: string | null): { ok: true; padRef: string } | { ok: false; error: string } {
  const padRef = padOriginFor(originRef);
  if (padRef) return { ok: true, padRef };
  return {
    ok: false,
    error:
      `The scratchpad belongs to one issue or one pull request and the agents working it, and this ` +
      `task's origin is ${originRef ?? '(none)'}, which is neither. If you noticed something outside ` +
      `your own task, use report_finding; if you are saying what you are working on right now, use note_progress.`,
  };
}

export function normalisePadNote(
  value: unknown,
  topic: unknown,
): { ok: true; note: string; topic: string | null; trimmed: boolean } | { ok: false; error: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return {
      ok: false,
      error:
        'note is required: what you learned, tried, or decided, in plain words — written for whoever ' +
        'works this goal next and for the retrospective at the end.',
    };
  }
  const tag = typeof topic === 'string' ? topic.replace(/\s+/g, ' ').trim().slice(0, MAX_PAD_TOPIC) : '';
  const trimmed = raw.length > MAX_PAD_NOTE;
  return { ok: true, note: trimmed ? raw.slice(0, MAX_PAD_NOTE) : raw, topic: tag || null, trimmed };
}
