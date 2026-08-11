/**
 * Finds the tool calls in a transcript, so the drawer can fold them out of the way of
 * the reasoning.
 *
 * The transcript is a flat text stream in every mode; the only structure it carries is
 * the labelled lines `renderBlocks` writes on the server. So this module recognises
 * those lines by shape and emits DOM *operations* rather than DOM, keeping it pure and
 * unit-testable the way `ansi.ts` is. `test/transcriptBlocks.test.ts` feeds it real
 * `renderBlocks` output — a marker written by one side and matched by another is the
 * drift the PTY sentinel scanner exists to prevent, and the round trip is what stops it
 * recurring here.
 *
 * Work is line-at-a-time: a partial trailing line is held in state, because a marker
 * split across two deltas must not half-parse, and handed back as `tail` so text still
 * being typed is shown rather than withheld.
 */
/** Named for the signatures below; the drawer reads ops structurally, so it stays unexported. */
interface BlockOp {
  /** `open` starts a block; `text` appends into whatever is current; `close` returns to the pane. */
  kind: 'open' | 'text' | 'close';
  /** The summary line for `open`, or the run to append for `text` — ANSI intact either way. */
  text?: string;
  /** `open` only: an error, which the pane renders expanded and never collapses. */
  error?: boolean;
}

export interface BlockState {
  /** An unterminated trailing line, held until its newline arrives. */
  pending: string;
  /** Whether a block is currently open. */
  inBlock: boolean;
  /**
   * Tool calls seen since the last result. Exactly one means the next result is
   * unambiguously its result; two or more means the agent fired them in parallel and
   * adjacency would pair them wrongly, so no result folds.
   */
  unresolved: number;
}

export const emptyBlockState: BlockState = { pending: '', inBlock: false, unresolved: 0 };

/** SGR is decoration; classification reads the bare text. */
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

const TOOL = /^⚙ /;
const RESULT = /^ {2}↳ (result|error)\b/;
/** A result body line is indented by two spaces — the renderer indents even blank ones. */
const BODY = /^ {2}/;

/** The most recent block opened in this chunk, if it was opened in this chunk at all. */
function lastOpen(ops: BlockOp[]): BlockOp | undefined {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (op?.kind === 'open') return op;
  }
  return undefined;
}

/**
 * Split `chunk` into block operations, resuming from `state`. Returns the operations,
 * the unterminated trailing line, and the state to thread into the next chunk.
 */
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
        // The result of the call directly above: fold it in, moving its line count onto
        // the summary, which is the one line an operator sees while it stays collapsed.
        const summary = lastOpen(ops);
        const suffix = line.slice(line.indexOf('↳')).replace(/^↳\s*(result|error)/, '');
        // The `open` may belong to an earlier chunk and be gone; the count is cosmetic.
        if (summary && suffix.replace(SGR, '').trim()) summary.text = `${summary.text ?? ''}${suffix}`;
      } else {
        open(line, error);
      }
      unresolved = 0;
      continue;
    }

    // A body line belongs to the open block; anything else has left it.
    if (inBlock && !BODY.test(text) && text.trim() !== '') close();
    ops.push({ kind: 'text', text: `${line}\n` });
  }

  return { ops, tail, state: { pending: tail, inBlock, unresolved } };
}
