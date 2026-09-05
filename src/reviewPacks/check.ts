import type { ReviewAttention, ReviewFinding, ReviewPack, ReviewRange, ReviewVerdict } from '../types.js';

/**
 * What the harness knows about the commission the checker is answering: the
 * document as the author left it, and the tree it may quote a contradiction
 * from. The checker is handed the ideas by id and the claims by number, and
 * names them back; it never sends a document.
 */
interface CheckCommission {
  pack: ReviewPack;
  /** The lines of one file at the head sha, plain, or null where the range names nothing there. */
  readRegion(range: ReviewRange): string[] | null;
}

/** How long a cue may be, the author's `gist` cap for the same reason it has one. */
const CUE_LIMIT = 70;

const ATTENTIONS: readonly ReviewAttention[] = ['read', 'decide', 'skim', 'split'];
const VERDICTS: readonly ReviewVerdict[] = ['true', 'false', 'cant_tell'];

/**
 * Merge the checker's verdicts onto the stored document, or refuse them by field
 * name. The inverse of `assemblePack`, and **the whole of the rule that the
 * checker may not edit the pack**: the document that comes out is the one that
 * went in with exactly these fields written — per idea `attention` and `cue`, per
 * claim `verdict`, `evidence` and, on a false one, `finding`; the `false` mark on
 * the step a finding names; the reading `order` — and nothing else can be
 * reached from the arguments. No claim is reworded, no anchor reassigned, no
 * `key` or `disputed` set, because there is no argument that would.
 *
 * Complete or refused: every idea gets a label, every claim a verdict, and the
 * order names every idea once. A checker that skipped a claim has not checked
 * the pack, and a document half-annotated would read as one where the checker
 * found nothing to say about the rest.
 * → `docs/spec/31-review-packs.md#the-check`
 */
export function applyCheck(
  commission: CheckCommission,
  args: Record<string, unknown>,
): { ok: true; pack: ReviewPack } | { ok: false; error: string } {
  const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error: `Check rejected: ${error}` });
  const pack = structuredClone(commission.pack);
  // A second merge — a resumed checker calling twice — starts from the author's
  // marks, not the last merge's: `false` is only ever written here.
  for (const idea of pack.ideas) for (const anchor of idea.anchors) if (anchor.mark === 'false') anchor.mark = null;

  if (!Array.isArray(args.ideas)) return refuse('ideas must be a list — one entry per idea you were handed.');
  const seen = new Set<string>();
  for (const [i, raw] of (args.ideas as unknown[]).entries()) {
    const at = `ideas[${i}]`;
    if (!isRecord(raw)) return refuse(`${at} must be an object.`);
    const id = line(raw.id);
    const idea = id === null ? undefined : pack.ideas.find((x) => x.id === id);
    if (!idea) return refuse(`${at}.id: no such idea ${id ?? '(missing)'} — the ids are the ones in your prompt.`);
    if (seen.has(idea.id)) return refuse(`${at}.id: ${idea.id} is answered twice.`);
    seen.add(idea.id);
    const attention = ATTENTIONS.find((a) => a === raw.attention);
    if (attention === undefined) return refuse(`${at}.attention must be one of read, decide, skim, split.`);
    const cue = line(raw.cue);
    if (cue === null) return refuse(`${at}.cue is required — one short line saying why the label is what it is.`);
    // The author's caps, applied to the one field the checker writes for the
    // person. → `docs/spec/31-review-packs.md#say-it-in-fewer-words`
    if (cue.length > CUE_LIMIT) {
      return refuse(
        `${at}.cue is ${cue.length} characters and the limit is ${CUE_LIMIT}. Say it in fewer words: the ` +
          `shortest plain wording, one idea, no clauses hung off dashes. Was: "${cue}"`,
      );
    }
    if (!Array.isArray(raw.claims)) return refuse(`${at}.claims must be a list — one entry per claim, by number.`);
    const answered = new Set<number>();
    for (const [j, rawClaim] of (raw.claims as unknown[]).entries()) {
      const where = `${at}.claims[${j}]`;
      if (!isRecord(rawClaim)) return refuse(`${where} must be an object.`);
      const n = rawClaim.claim;
      if (!isIndex(n) || n > idea.claims.length) {
        return refuse(
          `${where}.claim must be a claim number from your prompt (1–${idea.claims.length} on ${idea.id}).`,
        );
      }
      if (answered.has(n)) return refuse(`${where}.claim: claim ${n} on ${idea.id} is answered twice.`);
      answered.add(n);
      const verdict = VERDICTS.find((v) => v === rawClaim.verdict);
      if (verdict === undefined) return refuse(`${where}.verdict must be true, false or cant_tell.`);
      const evidence = text(rawClaim.evidence);
      if (evidence === null) {
        return refuse(
          `${where}.evidence is required — what you ran or read to decide, or why it cannot be decided here.`,
        );
      }
      const claim = idea.claims[n - 1]!;
      claim.verdict = verdict;
      claim.evidence = evidence;
      if (verdict !== 'false') {
        if (rawClaim.finding !== undefined && rawClaim.finding !== null) {
          return refuse(`${where}.finding belongs on a false claim only; this one is ${verdict}.`);
        }
        claim.finding = null;
        continue;
      }
      const finding = readFinding(commission, rawClaim.finding, `${where}.finding`, idea.anchors.length);
      if (!finding.ok) return refuse(finding.error);
      claim.finding = finding.finding;
      if (finding.finding.step !== null) idea.anchors[finding.finding.step - 1]!.mark = 'false';
    }
    if (answered.size < idea.claims.length) {
      const missing = idea.claims.map((_, k) => k + 1).filter((k) => !answered.has(k));
      return refuse(`${at}: every claim gets a verdict, and these on ${idea.id} have none: ${missing.join(', ')}.`);
    }
    idea.attention = attention;
    idea.cue = cue;
  }
  const unlabelled = pack.ideas.filter((x) => !seen.has(x.id));
  if (unlabelled.length > 0) {
    return refuse(`every idea gets a label, and these have none: ${unlabelled.map((x) => x.id).join(', ')}.`);
  }

  if (!Array.isArray(args.order)) return refuse('order must be a list of every idea id, in the order to read them.');
  const order = (args.order as unknown[]).map((o) => line(o));
  const ids = new Set(pack.ideas.map((x) => x.id));
  const stray = order.find((o) => o === null || !ids.has(o));
  if (stray !== undefined) return refuse(`order: no such idea ${stray ?? '(missing)'}.`);
  const twice = order.find((o, k) => order.indexOf(o) !== k);
  if (twice !== undefined) return refuse(`order: ${twice} is listed twice.`);
  if (order.length !== pack.ideas.length) {
    const left = [...ids].filter((id) => !order.includes(id));
    return refuse(`order must name every idea once, and leaves out: ${left.join(', ')}.`);
  }
  pack.order = order as string[];
  return { ok: true, pack };
}

function readFinding(
  commission: CheckCommission,
  raw: unknown,
  at: string,
  steps: number,
): { ok: true; finding: ReviewFinding } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: `${at} is required on a false claim — {headline, body, step?, counter?}.` };
  }
  const headline = line(raw.headline);
  if (headline === null)
    return { ok: false, error: `${at}.headline is required — one plain line saying what is wrong.` };
  const body = text(raw.body);
  if (body === null) {
    return { ok: false, error: `${at}.body is required — the consequence worked out, how serious it is, whose call.` };
  }
  let step: number | null = null;
  if (raw.step !== undefined && raw.step !== null) {
    if (!isIndex(raw.step) || raw.step > steps) {
      return { ok: false, error: `${at}.step must be a step of this idea's walk (1–${steps}), or be left out.` };
    }
    step = raw.step;
  }
  let counter: ReviewFinding['counter'] = null;
  if (raw.counter !== undefined && raw.counter !== null) {
    if (!isRecord(raw.counter)) return { ok: false, error: `${at}.counter must be {path, start, end, caption}.` };
    const path = line(raw.counter.path);
    const caption = line(raw.counter.caption);
    const { start, end } = raw.counter;
    if (path === null || caption === null || !isIndex(start) || !isIndex(end) || end < start) {
      return {
        ok: false,
        error: `${at}.counter needs a path, 1-based start and end lines with end >= start, and a one-line caption.`,
      };
    }
    const range: ReviewRange = { path, start, end };
    const code = commission.readRegion(range);
    if (code === null) {
      return {
        ok: false,
        error: `${at}.counter: ${path}:${start}-${end} is not in the tree at the head — check the path against your checkout and the range against the file's length.`,
      };
    }
    counter = { range, code, caption };
  }
  return { ok: true, finding: { headline, body, step, counter } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function line(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
