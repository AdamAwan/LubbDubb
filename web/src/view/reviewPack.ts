import type {
  ReviewAttention,
  ReviewClaim,
  ReviewIdea,
  ReviewMark,
  ReviewPack,
  ReviewPackPayload,
  ReviewRange,
} from '../types.js';

/**
 * The pack shape this renderer knows how to draw.
 *
 * Restated here rather than imported from `src/store/reviewPacks.ts`, because the
 * cockpit may name nothing of the harness but `src/wire.ts`, and that module
 * carries no runtime. So this and `REVIEW_PACK_SCHEMA` are two statements of one
 * number, held together by `test/reviewPackPage.test.ts`: a bump on one side and
 * not the other fails there, rather than turning every pack the harness writes
 * into one the page refuses. A pack stating any other number is refused **loudly**
 * — never rendered as far as it is recognised, since a page silently missing its
 * false-claim banner is the failure the subsystem exists to catch.
 * → docs/spec/31-review-packs.md#the-document-carries-its-schema-version
 */
export const KNOWN_REVIEW_PACK_SCHEMA = 1;

/** What a reviewer has done to one idea, read off the marks on the hunks it owns. */
export interface IdeaMarks {
  read: boolean;
  /** The reviewer's label over the checker's, or null where the checker's stands. */
  attention: ReviewAttention | null;
  /**
   * Whether the reader took the finding on this idea's false claim. Drawn under
   * the finding, and counted: a pull request that merged with this unset is a
   * false claim nobody read.
   * → docs/spec/31-review-packs.md#whether-prominence-works
   */
  seen: boolean;
}

/** The hunks an idea owns — the `hunk` anchors; a `region` is a reference, not ownership. */
function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

const hunkKey = (r: ReviewRange): string => `${r.path}:${r.start}-${r.end}`;

/**
 * Lay the reviewer's marks over the ideas that own the hunks they ride on.
 *
 * A mark is keyed to a hunk and never an idea, so this is where the two meet:
 * an idea is **read** only when every hunk it owns carries a read mark, is **seen**
 * only when every hunk it owns is, and wears an override only when every hunk it
 * owns agrees on one. Both are the honest
 * reading across a rewrite — the next pack may fold two ideas into one, and
 * calling the union read because half of it was is the lie the per-hunk key
 * exists to avoid. A hunk the new head rewrote has no mark, so the idea that owns
 * it reads unread: the thing that was read is gone. An idea owning no hunk at all
 * — a walk of regions only — can carry no mark and reads unread.
 * → docs/spec/31-review-packs.md#what-a-reviewer-does-is-not-part-of-the-pack
 */
export function layMarks(pack: ReviewPack, marks: readonly ReviewMark[]): Map<string, IdeaMarks> {
  const byHunk = new Map(marks.map((m) => [hunkKey(m.hunk), m]));
  const laid = new Map<string, IdeaMarks>();
  for (const idea of pack.ideas) {
    const hunks = ownedHunks(idea);
    const own = hunks.map((h) => byHunk.get(hunkKey(h)) ?? null);
    const read = hunks.length > 0 && own.every((m) => m !== null && m.read);
    const seen = hunks.length > 0 && own.every((m) => m !== null && m.seen);
    const first = own[0]?.attention ?? null;
    const attention =
      hunks.length > 0 && first !== null && own.every((m) => m !== null && m.attention === first) ? first : null;
    laid.set(idea.id, { read, attention, seen });
  }
  return laid;
}

/**
 * Where the pack stands with the checker. `checked` is read off the reading
 * `order`, which the check fills only when it is complete — the tool refuses a
 * half-annotated document — so an empty order with nobody checking is a pack the
 * checker never finished: a paused fleet, a checker that failed. That state is
 * drawn as itself, never as "fine", and the recovery is asking again.
 * → docs/spec/31-review-packs.md#the-check
 */
type PackStanding = 'unchecked' | 'checking' | 'checked';

export function packStanding(payload: Pick<ReviewPackPayload, 'pack' | 'checking'>): PackStanding {
  if (payload.pack.order.length > 0) return 'checked';
  return payload.checking ? 'checking' : 'unchecked';
}

/**
 * Whether the pack is about the head the pull request is on. Three answers, and
 * the third is not the first: a pull request the world no longer carries has no
 * head to compare against, and a reader must not fold that into "current".
 */
type PackCurrency =
  | { kind: 'current' }
  | { kind: 'stale'; headSha: string; commitsBehind: number | null }
  | { kind: 'gone' };

export function packCurrency(payload: Pick<ReviewPackPayload, 'head' | 'stale'>): PackCurrency {
  if (payload.head === null) return { kind: 'gone' };
  if (payload.stale === null) return { kind: 'current' };
  return { kind: 'stale', headSha: payload.stale.headSha, commitsBehind: payload.stale.commitsBehind };
}

/** One idea with the number the page gives it. */
export interface NumberedIdea {
  idea: ReviewIdea;
  /** 1-based, as the rows and the finding's `step` reference them. */
  number: number;
}

/**
 * The ideas in the order the page draws them, numbered. By the checker's `order`
 * when it has run — the numbers *are* the reading order, which is why they are
 * numbers — and by document order when it has not, and the page says which. An
 * idea the order somehow does not name (the tool refuses such an order, so this
 * is defence rather than a case) is drawn after the ordered ones rather than lost.
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
 * the finding boxes draw: there is no separate findings list on the pack, so the
 * count and the boxes cannot disagree.
 * → docs/spec/31-review-packs.md#what-a-false-claim-does
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

/** The masthead's facts line, every figure read off the document. */
interface PackFacts {
  ideas: number;
  /** Distinct files the change touches — the paths of the hunk anchors. */
  files: number;
  /** Hunks owned across every idea; the coverage check makes this every hunk in the diff. */
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

/** `?idea=all` — the open-all control, as a value of the one place field that names a fold. */
export const ALL_IDEAS = 'all';

/** Whether an idea's walk is unfolded, given what the address bar says. */
export function ideaOpen(openIdea: string | null, id: string): boolean {
  return openIdea === ALL_IDEAS || openIdea === id;
}

/** A sha the way the page prints one: seven characters, or the whole thing when it is shorter. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
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

/**
 * The languages a code block is highlighted in, decided from the anchor's path.
 * Null is "draw it plain", and is the honest answer for everything else: a
 * tokenizer guessing at a language it does not know **mis**-colours, and a
 * confident wrong colour is worse to read than no colour at all.
 */
type CodeLanguage = 'ts' | 'json';

/** The language of a file, by extension, or null to draw it plain. */
export function codeLanguage(path: string): CodeLanguage | null {
  if (/\.[cm]?[jt]sx?$/.test(path)) return 'ts';
  if (/\.json[c5]?$/.test(path)) return 'json';
  return null;
}

/** One run of a line, with what it is. `plain` is everything the scanner does not name. */
interface CodeToken {
  kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword';
  text: string;
}

const TS_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'new',
  'null',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'void',
  'while',
  'yield',
]);
const JSON_KEYWORDS = new Set(['true', 'false', 'null']);

/**
 * Split a block of code into coloured runs, line by line.
 * → `docs/spec/31-review-packs.md#the-code-block`
 *
 * **Rendered here, never in the browser.** The companion is one self-contained
 * file with no script and no request, so a highlighter that runs on the page is
 * not available to it, and a pack that highlighted in the cockpit and not in the
 * companion would be two pages disagreeing about what the code says.
 *
 * The whole block is scanned at once and cut at newlines afterwards, so a block
 * comment or a template literal that spans lines is one run rather than a
 * mis-coloured line each. What it deliberately does not do: no regular
 * expressions (telling one from a division needs a parser, and the wrong guess
 * silently swallows the rest of the line), no interpolation inside a template
 * literal, and no identifier classification beyond the keyword list — the parts
 * of a highlighter that are wrong often enough to cost more than they give.
 *
 * A quoted string never runs past its own line: the code arrives as a hunk, which
 * can begin and end anywhere, and a stray quote on a cut boundary would otherwise
 * colour every line under it.
 */
export function highlightCode(code: readonly string[], language: CodeLanguage | null): CodeToken[][] {
  if (language === null) return code.map((text) => [{ kind: 'plain', text }]);
  const source = code.join('\n');
  const words = language === 'ts' ? TS_KEYWORDS : JSON_KEYWORDS;
  const runs: CodeToken[] = [];
  let plain = '';
  const keep = (kind: CodeToken['kind'], text: string): void => {
    if (plain !== '') {
      runs.push({ kind: 'plain', text: plain });
      plain = '';
    }
    if (text !== '') runs.push({ kind, text });
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (language === 'ts' && rest.startsWith('//')) {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      keep('comment', source.slice(i, stop));
      i = stop;
      continue;
    }
    if (language === 'ts' && rest.startsWith('/*')) {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      keep('comment', source.slice(i, stop));
      i = stop;
      continue;
    }
    const quote = source[i]!;
    if (quote === '"' || quote === "'" || (language === 'ts' && quote === '`')) {
      let j = i + 1;
      while (j < source.length) {
        const c = source[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) {
          j += 1;
          break;
        }
        // A quoted string cannot span a line, and a hunk can be cut anywhere.
        if (c === '\n' && quote !== '`') break;
        j += 1;
      }
      keep('string', source.slice(i, j));
      i = j;
      continue;
    }
    const c = source[i]!;
    if (c >= '0' && c <= '9' && !/[\w$]/.test(source[i - 1] ?? '')) {
      let j = i;
      while (j < source.length && /[\w.]/.test(source[j]!)) j += 1;
      keep('number', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < source.length && /[\w$]/.test(source[j]!)) j += 1;
      const word = source.slice(i, j);
      if (words.has(word)) keep('keyword', word);
      else plain += word;
      i = j;
      continue;
    }
    plain += c;
    i += 1;
  }
  keep('plain', '');

  // Back into lines, splitting the runs that crossed one.
  const lines: CodeToken[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split('\n');
    parts.forEach((part, k) => {
      if (k > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1]!.push({ kind: run.kind, text: part });
    });
  }
  // `code.join` produced exactly one line per input line; anything else is a bug
  // here rather than something to paper over at the call site.
  while (lines.length < code.length) lines.push([]);
  return lines.slice(0, Math.max(code.length, 0));
}
