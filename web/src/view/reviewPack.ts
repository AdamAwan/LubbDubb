import type {
  ReviewAnchor,
  ReviewAttention,
  ReviewClaim,
  ReviewIdea,
  ReviewMark,
  ReviewPack,
  ReviewPackPayload,
  ReviewRange,
} from '../types.js';

/**
 * The pack shape this renderer knows how to draw. Restated here rather than imported, since the
 * cockpit may name nothing of the harness but `src/wire.ts`; held in sync with `REVIEW_PACK_SCHEMA`
 * by `test/reviewPackPage.test.ts`. A pack stating any other number is refused **loudly**.
 * → docs/spec/31-review-packs.md#the-document-carries-its-schema-version
 */
export const KNOWN_REVIEW_PACK_SCHEMA = 1;

/** What a reviewer has done to one idea, read off the marks on the hunks it owns. */
export interface IdeaMarks {
  read: boolean;
  /** The reviewer's label over the checker's, or null where the checker's stands. */
  attention: ReviewAttention | null;
  /**
   * Whether the reader took the finding on this idea's false claim; a merged pull request with
   * this unset is a false claim nobody read. → docs/spec/31-review-packs.md#whether-prominence-works
   */
  seen: boolean;
}

/** The hunks an idea owns — the `hunk` anchors; a `region` is a reference, not ownership. */
function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

const hunkKey = (r: ReviewRange): string => `${r.path}:${r.start}-${r.end}`;

/**
 * Lay the reviewer's marks over the ideas that own the hunks they ride on. A mark is keyed to a
 * hunk, never an idea: an idea is **read** only when every hunk it owns carries a read mark, **seen**
 * only when every hunk it owns is, and wears an override only when every hunk agrees on one. A hunk
 * the new head rewrote has no mark, so the idea reads unread; an idea owning no hunk reads unread too.
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
 * Where the pack stands with the checker. `checked` is read off `order`, which the check fills
 * only when complete; an empty order with nobody checking means the checker never finished, drawn
 * as itself rather than "fine". → docs/spec/31-review-packs.md#the-check
 */
type PackStanding = 'unchecked' | 'checking' | 'checked';

export function packStanding(payload: Pick<ReviewPackPayload, 'pack' | 'checking'>): PackStanding {
  if (payload.pack.order.length > 0) return 'checked';
  return payload.checking ? 'checking' : 'unchecked';
}

/** Whether the pack is about the head the pull request is on. `gone` (no head to compare) must not fold into `current`. */
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
 * The ideas in the order the page draws them, numbered — by the checker's `order` when it has run,
 * by document order when it has not. An idea the order somehow does not name is drawn after the
 * ordered ones rather than lost.
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
 * Every claim the checker marked false, in page order. What the gate counts and the finding boxes
 * draw, so the count and the boxes cannot disagree. → docs/spec/31-review-packs.md#what-a-false-claim-does
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
 * One line of an embedded code block, with the diff marker taken **out of the text** — kept as its
 * own column rather than shifting indentation or landing in anything copied.
 * → `docs/spec/31-review-packs.md#the-code-block`
 */
interface CodeLine {
  /** `+`, `-` or `' '` for a diff line; null for a region's plain lines. */
  marker: '+' | '-' | ' ' | null;
  text: string;
}

/**
 * A code block split for rendering: the lines, and whether the marker column is worth drawing.
 * **Dropped when every line carries the same marker** — a new file, a pure insertion — since the
 * tag above already says as much; drawn once a block mixes markers.
 */
export function codeBlockLines(code: readonly string[], diff: boolean): { gutter: boolean; lines: CodeLine[] } {
  if (!diff) return { gutter: false, lines: code.map((text) => ({ marker: null, text })) };
  const lines: CodeLine[] = code.map((line) => {
    const head = line.slice(0, 1);
    if (head === '+' || head === '-' || head === ' ') return { marker: head, text: line.slice(1) };
    // A line git printed without a prefix (e.g. "\ No newline"). Kept whole.
    return { marker: null, text: line };
  });
  const first = lines[0]?.marker ?? null;
  const gutter = lines.length > 0 && lines.some((l) => l.marker !== first);
  return { gutter, lines };
}

/**
 * How much of a look one stop wants, decided from the code rather than declared, since a walk mixes
 * an import block and a fifty-line function and would otherwise draw them as equals.
 * `key` is the author's own mark; `minor` is a stop that costs nothing (all-import or ≤2 changed
 * lines), drawn quiet with code folded; `normal` is everything else. **Derived, never authored** —
 * a region anchor is never `minor`, since it's in the pack because it couldn't be judged without it.
 * → `docs/spec/31-review-packs.md#how-hard-to-look-at-one-stop`
 */
export function anchorWeight(anchor: ReviewAnchor): 'key' | 'normal' | 'minor' {
  if (anchor.mark === 'key') return 'key';
  if (anchor.kind !== 'hunk') return 'normal';
  const changed = anchor.code.filter((l) => l.startsWith('+') || l.startsWith('-'));
  if (changed.length === 0) return 'minor';
  if (changed.every((l) => IMPORT_LINE.test(l))) return 'minor';
  // Few lines isn't the same as little to read — one line can be a thousand characters. So both.
  const written = changed.reduce((n, l) => n + l.trim().length, 0);
  return changed.length <= MINOR_LINES && written <= MINOR_CHARS ? 'minor' : 'normal';
}

/** A changed line that is part of an import or export statement, including its wrapped members. */
const IMPORT_LINE =
  /^[+-]\s*(?:import\b|export\s+(?:\*|\{|type\b)|\}?\s*from\s|[A-Za-z_$][\w$]*\s*,?\s*$|\{\s*$|\}\s*$)/;

/** Changed lines at or under which a hunk may carry nothing to stop for. */
const MINOR_LINES = 2;

/** And the characters within them, because one line can hold a whole prompt. */
const MINOR_CHARS = 160;

/** The language a code block is highlighted in, decided from the anchor's path. Null draws it plain — a wrong guess mis-colours worse than no colour. */
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
 * Split a block of code into coloured runs, line by line. **Rendered here, never in the
 * browser** — the companion page has no script, and highlighting must match it exactly. Scans the
 * whole block at once so multi-line comments/templates are one run. Deliberately skips regex
 * detection and interpolation. A quoted string never runs past its own line, since a hunk can be
 * cut anywhere and a stray quote would otherwise colour everything under it.
 * → `docs/spec/31-review-packs.md#the-code-block`
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
  // `code.join` produced one line per input line; anything else is a bug here.
  while (lines.length < code.length) lines.push([]);
  return lines.slice(0, Math.max(code.length, 0));
}
