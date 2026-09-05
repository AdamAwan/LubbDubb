import type { ReviewClaim, ReviewIdea, ReviewPack, ReviewRange } from '../types.js';

/**
 * The derivations a rendering of a pack needs, on the harness's side.
 *
 * **Two statements of one set of rules, held together by a test.** The cockpit's
 * copy is `web/src/view/reviewPack.ts` and this is the companion's, and neither
 * can import the other: `web/src/` may name no server module but `src/wire.ts`,
 * which carries no runtime, so there is no one place both can reach. That is the
 * same arrangement `KNOWN_REVIEW_PACK_SCHEMA` already has, for the same reason and
 * with the same defence — `test/reviewPackCompanion.test.ts` runs both over one
 * pack and asserts they agree, so a rule changed on one side and not the other
 * fails there rather than shipping two pages that disagree about which idea is
 * number one.
 *
 * Nothing here reads a rendering, holds state, or touches the store: a pack is
 * data and every rendering is downstream of it.
 * → `docs/spec/31-review-packs.md#a-pack-is-data-and-rendering-is-downstream`
 */

/** The hunks an idea owns — the `hunk` anchors; a `region` is a reference, not ownership. */
function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

/** One idea with the number the page gives it. */
interface NumberedIdea {
  idea: ReviewIdea;
  /** 1-based, as the rows and the finding's `step` reference them. */
  number: number;
}

/**
 * The ideas in the order the page draws them, numbered — by the checker's `order`
 * where it has run, and by document order until then, with the page saying which.
 * An idea the order does not name is drawn after the ordered ones rather than
 * lost.
 */
export function numberIdeas(pack: ReviewPack): { by: 'order' | 'document'; ideas: NumberedIdea[] } {
  if (pack.order.length === 0) {
    return { by: 'document', ideas: pack.ideas.map((idea, i) => ({ idea, number: i + 1 })) };
  }
  const byId = new Map(pack.ideas.map((idea) => [idea.id, idea]));
  const ordered: ReviewIdea[] = [];
  for (const id of pack.order) {
    const idea = byId.get(id);
    if (idea !== undefined && !ordered.includes(idea)) ordered.push(idea);
  }
  for (const idea of pack.ideas) if (!ordered.includes(idea)) ordered.push(idea);
  return { by: 'order', ideas: ordered.map((idea, i) => ({ idea, number: i + 1 })) };
}

/** A false claim, with the idea it sits on and where that idea is numbered. */
export interface FalseClaim {
  idea: ReviewIdea;
  number: number;
  /** 1-based, as the claims list numbers them. */
  claimNumber: number;
  claim: ReviewClaim;
}

/**
 * Every claim the checker marked false, in page order. What the gate counts and
 * the finding boxes draw, off one derivation so the two cannot disagree.
 * → `docs/spec/31-review-packs.md#what-a-false-claim-does`
 */
export function falseClaims(pack: ReviewPack): FalseClaim[] {
  const out: FalseClaim[] = [];
  for (const { idea, number } of numberIdeas(pack).ideas) {
    idea.claims.forEach((claim, i) => {
      if (claim.verdict === 'false') out.push({ idea, number, claimNumber: i + 1, claim });
    });
  }
  return out;
}

/** What an idea's collapsed row must say even to a reader who opens nothing. */
export function ideaFlags(idea: ReviewIdea): { falseClaims: number; disputed: number } {
  return {
    falseClaims: idea.claims.filter((c) => c.verdict === 'false').length,
    disputed: idea.claims.filter((c) => c.provenance.kind === 'disputed').length,
  };
}

/** The masthead's facts line, every figure read off the document rather than stated in it. */
interface PackFacts {
  ideas: number;
  files: number;
  changes: number;
  claims: { total: number; true: number; false: number; cantTell: number; unchecked: number };
}

export function packFacts(pack: ReviewPack): PackFacts {
  const files = new Set<string>();
  let changes = 0;
  const claims = { total: 0, true: 0, false: 0, cantTell: 0, unchecked: 0 };
  for (const idea of pack.ideas) {
    for (const hunk of ownedHunks(idea)) {
      files.add(hunk.path);
      changes += 1;
    }
    for (const claim of idea.claims) {
      claims.total += 1;
      if (claim.verdict === 'true') claims.true += 1;
      else if (claim.verdict === 'false') claims.false += 1;
      else if (claim.verdict === 'cant_tell') claims.cantTell += 1;
      else claims.unchecked += 1;
    }
  }
  return { ideas: pack.ideas.length, files: files.size, changes, claims };
}

/**
 * One line of an embedded code block, with the diff marker taken **out of the
 * text**. → `docs/spec/31-review-packs.md#the-code-block`
 *
 * A hunk's lines arrive as git printed them, so every line carries a leading
 * `+`, `-` or space. Printed inline that marker is the first character of the
 * code: it shifts the indentation by a column, it lands in anything the reader
 * copies, and on a new file — where every line is an addition — a whole screen
 * of `+` says one thing the tag above the block already said. The marker is a
 * column of its own here, and `text` is the code as it actually reads.
 */
interface CodeLine {
  /** `+`, `-` or `' '` for a diff line; null for a region's plain lines. */
  marker: '+' | '-' | ' ' | null;
  text: string;
}

/**
 * A code block split for rendering: the lines, and whether the marker column is
 * worth drawing at all.
 *
 * **The gutter is dropped when every line carries the same marker** — a new
 * file, a deleted one, a pure insertion. There is nothing to tell apart, the tag
 * on the step already says `changed +102`, and the column is a screen-tall
 * repetition of one character. It is drawn the moment a block mixes markers,
 * because that is when it carries the information.
 */
export function codeBlockLines(code: readonly string[], diff: boolean): { gutter: boolean; lines: CodeLine[] } {
  if (!diff) return { gutter: false, lines: code.map((text) => ({ marker: null, text })) };
  const lines: CodeLine[] = code.map((line) => {
    const head = line.slice(0, 1);
    if (head === '+' || head === '-' || head === ' ') return { marker: head, text: line.slice(1) };
    // A line git printed without a prefix — the "\ No newline" trailer, or a
    // pack from a build that embedded them plain. Kept whole rather than losing
    // its first character to a column it never had.
    return { marker: null, text: line };
  });
  const first = lines[0]?.marker ?? null;
  const gutter = lines.length > 0 && lines.some((l) => l.marker !== first);
  return { gutter, lines };
}

/** A sha the way a page prints one: seven characters, or the whole thing when it is shorter. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
