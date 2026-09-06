// → docs/spec/17-cockpit.md

interface BlockOp {
  kind: 'open' | 'text' | 'close';
  text?: string;
  error?: boolean;
}

export interface BlockState {
  pending: string;
  inBlock: boolean;
  unresolved: number;
}

export const emptyBlockState: BlockState = { pending: '', inBlock: false, unresolved: 0 };

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

const TOOL = /^(?:\[\d{2}:\d{2}:\d{2}\] )?⚙ /;
const RESULT = /^ {2}↳ (result|error)\b/;
const BODY = /^ {2}/;

function lastOpen(ops: BlockOp[]): BlockOp | undefined {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (op?.kind === 'open') return op;
  }
  return undefined;
}

export function feedBlocks(chunk: string, state: BlockState): { ops: BlockOp[]; tail: string; state: BlockState } {
  const ops: BlockOp[] = [];
  let inBlock = state.inBlock;
  let unresolved = state.unresolved;
  const lines = (state.pending + chunk).split('\n');
  const tail = lines.pop() ?? '';

  const close = (): void => {
    if (inBlock) ops.push({ kind: 'close' });
    inBlock = false;
  };
  const open = (text: string, error: boolean): void => {
    close();
    ops.push({ kind: 'open', text, error });
    inBlock = true;
  };

  for (const line of lines) {
    const text = line.replace(SGR, '');

    if (TOOL.test(text)) {
      open(line, false);
      unresolved += 1;
      continue;
    }

    const result = RESULT.exec(text);
    if (result) {
      const error = result[1] === 'error';
      if (!error && unresolved === 1 && inBlock) {
        const summary = lastOpen(ops);
        const suffix = line.slice(line.indexOf('↳')).replace(/^↳\s*(result|error)/, '');
        if (summary && suffix.replace(SGR, '').trim()) summary.text = `${summary.text ?? ''}${suffix}`;
      } else {
        open(line, error);
      }
      unresolved = 0;
      continue;
    }

    if (inBlock && !BODY.test(text) && text.trim() !== '') close();
    ops.push({ kind: 'text', text: `${line}\n` });
  }

  return { ops, tail, state: { pending: tail, inBlock, unresolved } };
}
