const MAX_LINE = 200;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day (`YYYY-MM-DD`) of an ISO instant or an epoch-milliseconds time. */
export function utcDay(at: string | number): string {
  return (typeof at === 'number' ? new Date(at).toISOString() : at).slice(0, 10);
}

export function sentence(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

export function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, MAX_LINE);
}

export function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/* Linear interpolation between the two nearest ranks of an already-sorted list. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export function prNumberOf(ref: string): number | null {
  const found = /^pr:(\d+)$/.exec(ref)?.[1];
  return found === undefined ? null : Number(found);
}

export function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const held = grouped.get(key(row));
    if (held) held.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
