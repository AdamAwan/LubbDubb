// → docs/spec/37-bot-prs.md#what-the-agent-is-given

const CONTEXT = 3;
const MAX_LINES = 2_000;

type Op = { kind: ' ' | '-' | '+'; line: string };

interface LineDiff {
  patch: string | null;
  additions: number | null;
  deletions: number | null;
}

/**
 * A unified diff of two texts, for a provider that serves file contents and no patch. The shared
 * head and tail are trimmed before the quadratic table, so a one-line bump in a long manifest costs
 * almost nothing; a changed middle past `MAX_LINES` a side goes without a patch or counts.
 */
export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length > MAX_LINES || midB.length > MAX_LINES) return { patch: null, additions: null, deletions: null };
  const middle = diffOps(midA, midB);
  const kept = (lines: string[]): Op[] => lines.map((line) => ({ kind: ' ', line }));
  const ops = [...kept(a.slice(0, head)), ...middle.ops, ...kept(a.slice(a.length - tail))];
  const changed = middle.additions + middle.deletions > 0;
  return { patch: changed ? hunks(ops) : null, additions: middle.additions, deletions: middle.deletions };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): { ops: Op[]; additions: number; deletions: number } {
  const width = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const ops: Op[] = [];
  let [i, j, additions, deletions] = [0, 0, 0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]! });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      ops.push({ kind: '-', line: a[i++]! });
      deletions += 1;
    } else {
      ops.push({ kind: '+', line: b[j++]! });
      additions += 1;
    }
  }
  return { ops, additions, deletions };
}

function hunks(ops: Op[]): string {
  const keep = ops.map(() => false);
  ops.forEach((op, k) => {
    if (op.kind === ' ') return;
    for (let n = Math.max(0, k - CONTEXT); n <= Math.min(ops.length - 1, k + CONTEXT); n += 1) keep[n] = true;
  });
  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (let k = 0; k < ops.length;) {
    if (!keep[k]) {
      oldLine += 1;
      newLine += 1;
      k += 1;
      continue;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const body: string[] = [];
    for (; k < ops.length && keep[k]; k += 1) {
      const op = ops[k]!;
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== '+') oldLine += 1;
      if (op.kind !== '-') newLine += 1;
    }
    const range = (start: number, end: number): string => `${String(start)},${String(end - start)}`;
    out.push(`@@ -${range(oldStart, oldLine)} +${range(newStart, newLine)} @@`, ...body);
  }
  return out.join('\n');
}
