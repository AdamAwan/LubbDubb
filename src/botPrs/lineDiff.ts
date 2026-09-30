// → docs/spec/37-bot-prs.md#what-the-agent-is-given

const CONTEXT = 3;
const MAX_LINES = 2_000;

type Op = { kind: ' ' | '-' | '+'; line: string };

interface LineDiff {
  patch: string | null;
  additions: number;
  deletions: number;
}

/**
 * A unified diff of two texts, for a provider that serves file contents and no patch. Null patch
 * where either side is past `MAX_LINES`: the table below is quadratic, and a manifest that long is
 * not one a risk reader gets through anyway.
 */
export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return { patch: null, ...roughCounts(a, b) };
  const ops = diffOps(a, b);
  return {
    patch: ops.some((op) => op.kind !== ' ') ? hunks(ops) : null,
    additions: ops.filter((op) => op.kind === '+').length,
    deletions: ops.filter((op) => op.kind === '-').length,
  };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): Op[] {
  const width = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) ops.push({ kind: '-', line: a[i++]! });
    else ops.push({ kind: '+', line: b[j++]! });
  }
  while (i < a.length) ops.push({ kind: '-', line: a[i++]! });
  while (j < b.length) ops.push({ kind: '+', line: b[j++]! });
  return ops;
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
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k]!.kind !== '+') oldLine += 1;
      if (ops[k]!.kind !== '-') newLine += 1;
      k += 1;
      continue;
    }
    const body: string[] = [];
    const [oldStart, newStart] = [oldLine, newLine];
    let [oldCount, newCount] = [0, 0];
    for (; k < ops.length && keep[k]; k += 1) {
      const op = ops[k]!;
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== '+') [oldLine, oldCount] = [oldLine + 1, oldCount + 1];
      if (op.kind !== '-') [newLine, newCount] = [newLine + 1, newCount + 1];
    }
    out.push(`@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@`, ...body);
  }
  return out.join('\n');
}

function roughCounts(a: string[], b: string[]): { additions: number; deletions: number } {
  const before = new Set(a);
  const after = new Set(b);
  return { additions: b.filter((l) => !before.has(l)).length, deletions: a.filter((l) => !after.has(l)).length };
}
