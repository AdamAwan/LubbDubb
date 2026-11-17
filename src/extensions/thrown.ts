// → docs/spec/42-extensions.md#calling-a-slot

export function thrownText(err: unknown): string {
  const message = field(err, 'message');
  if (typeof message === 'string') return message;
  if (err !== null && (typeof err === 'object' || typeof err === 'function'))
    return 'it threw a value that is not an error';
  return String(err);
}

export function thrownStack(err: unknown): string | null {
  const stack = field(err, 'stack');
  return typeof stack === 'string' ? stack : null;
}

function field(err: unknown, key: 'message' | 'stack'): unknown {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return undefined;
  try {
    return (err as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
