import type { ReviewAnchor, ReviewClaim, ReviewIdea, ReviewPack, ReviewRange } from '../types.js';
import { PLUMBING_IDEA_ID } from './hunks.js';

// → docs/spec/31-review-packs.md

function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

interface NumberedIdea {
  idea: ReviewIdea;
  number: number;
}

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

export interface FalseClaim {
  idea: ReviewIdea;
  number: number;
  claimNumber: number;
  claim: ReviewClaim;
}

export function falseClaims(pack: ReviewPack): FalseClaim[] {
  const out: FalseClaim[] = [];
  for (const { idea, number } of numberIdeas(pack).ideas) {
    idea.claims.forEach((claim, i) => {
      if (claim.verdict === 'false') out.push({ idea, number, claimNumber: i + 1, claim });
    });
  }
  return out;
}

type IdeaAtom = { kind: 'declared'; slug: string } | { kind: 'undeclared' } | { kind: 'none' };

/**
 * The atom an idea corresponds to, and what its absence means.
 *
 * `undeclared` only where the pack has atoms behind it at all: an idea no atom
 * covers is the pack's most valuable sentence — the work went somewhere the plan
 * did not declare — and a pack for a pull request with no atoms behind it draws
 * `none`, which is nothing at all.
 *
 * `plumbing` is exempt: it owns the hunks that carry nothing to review, which no
 * planner would ever have declared an atom for, so reading it as undeclared work
 * would put a false finding on every pack that has atoms.
 * → docs/spec/31-review-packs.md#an-idea-the-atoms-do-not-cover-is-a-finding
 */
export function ideaAtom(pack: ReviewPack, idea: ReviewIdea): IdeaAtom {
  const named = idea.atom ?? null;
  if (named !== null) return { kind: 'declared', slug: named };
  if (idea.id === PLUMBING_IDEA_ID) return { kind: 'none' };
  return pack.ideas.some((i) => (i.atom ?? null) !== null) ? { kind: 'undeclared' } : { kind: 'none' };
}

export function ideaFlags(idea: ReviewIdea): { falseClaims: number; disputed: number } {
  return {
    falseClaims: idea.claims.filter((c) => c.verdict === 'false').length,
    disputed: idea.claims.filter((c) => c.provenance.kind === 'disputed').length,
  };
}

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

interface CodeLine {
  marker: '+' | '-' | ' ' | null;
  text: string;
}

export function codeBlockLines(code: readonly string[], diff: boolean): { gutter: boolean; lines: CodeLine[] } {
  if (!diff) return { gutter: false, lines: code.map((text) => ({ marker: null, text })) };
  const lines: CodeLine[] = code.map((line) => {
    const head = line.slice(0, 1);
    if (head === '+' || head === '-' || head === ' ') return { marker: head, text: line.slice(1) };
    return { marker: null, text: line };
  });
  const first = lines[0]?.marker ?? null;
  const gutter = lines.length > 0 && lines.some((l) => l.marker !== first);
  return { gutter, lines };
}

export function anchorWeight(anchor: ReviewAnchor): 'key' | 'normal' | 'minor' {
  if (anchor.mark === 'key') return 'key';
  if (anchor.kind !== 'hunk') return 'normal';
  const changed = anchor.code.filter((l) => l.startsWith('+') || l.startsWith('-'));
  if (changed.length === 0) return 'minor';
  if (changed.every((l) => IMPORT_LINE.test(l))) return 'minor';
  if (commentOnly(anchor.range.path, changed)) return 'minor';
  const written = changed.reduce((n, l) => n + l.trim().length, 0);
  return changed.length <= MINOR_LINES && written <= MINOR_CHARS ? 'minor' : 'normal';
}

const IMPORT_LINE =
  /^[+-]\s*(?:import\b|export\s+(?:\*|\{|type\b)|\}?\s*from\s|[A-Za-z_$][\w$]*\s*,?\s*$|\{\s*$|\}\s*$)/;

const MINOR_LINES = 2;

const MINOR_CHARS = 160;

/**
 * A hunk that changed only comments — a doc line reworded, a `<summary>` rewritten.
 * It is a change a reader has no decision to make about, so it is drawn as one.
 * Prose files are exempt: in Markdown a `#` line is the text, not a comment about it.
 */
function commentOnly(path: string, changed: readonly string[]): boolean {
  if (PROSE_FILE.test(path)) return false;
  return changed.every((l) => COMMENT_LINE.test(l));
}

const PROSE_FILE = /\.(?:md|markdown|txt|html?|rst|adoc)$/i;

const COMMENT_LINE = /^[+-]\s*(?:\/\/|\/\*|\*|#|--|<!--|<\/?summary>|<\/?remarks>)/;

type CodeLanguage = 'ts' | 'json';

export function codeLanguage(path: string): CodeLanguage | null {
  if (/\.[cm]?[jt]sx?$/.test(path)) return 'ts';
  if (/\.json[c5]?$/.test(path)) return 'json';
  return null;
}

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

  const lines: CodeToken[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split('\n');
    parts.forEach((part, k) => {
      if (k > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1]!.push({ kind: run.kind, text: part });
    });
  }
  while (lines.length < code.length) lines.push([]);
  return lines.slice(0, Math.max(code.length, 0));
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * The summary with the author's emphasis flattened.
 *
 * → docs/spec/31-review-packs.md#the-page
 */
export function plainSummary(summary: string): string {
  return summary.replace(/(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/g, '$2');
}

/**
 * A prose body, split into its first paragraph and the rest.
 *
 * → docs/spec/31-review-packs.md#the-page
 */
export function splitBody(body: string): { lead: string; rest: string } {
  const at = body.indexOf('\n\n');
  if (at < 0) return { lead: body.trim(), rest: '' };
  return { lead: body.slice(0, at).trim(), rest: body.slice(at).trim() };
}

/**
 * The scenarios a test file's code declares, named the way a person would say them.
 *
 * → docs/spec/31-review-packs.md#coverage
 */
export function testScenarios(path: string, code: readonly string[]): string[] {
  if (!TEST_FILE.test(path)) return [];
  const names: string[] = [];
  for (const raw of code) {
    const line = raw.replace(/^[+\- ]/, '');
    const named = TEST_NAMED.exec(line);
    if (named !== null) {
      const name = named[1]!.trim();
      if (name !== '' && !names.includes(name)) names.push(name);
      continue;
    }
    const method = TEST_METHOD.exec(line);
    if (method !== null) {
      const name = humanise(method[1]!);
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.length >= MIN_SCENARIOS ? names : [];
}

const TEST_FILE = /(?:[Tt]ests?|[Ss]pecs?)\.[a-z]+$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|specs?)\//;

const TEST_NAMED = /^\s*(?:it|test)(?:\.\w+)?\s*\(\s*['"`]([^'"`]+)['"`]/;

const TEST_METHOD =
  /^\s*(?:\[[^\]]*\]\s*)?(?:public|internal|private|protected)\s+(?:static\s+)?(?:async\s+)?(?:Task|void)\s+([A-Za-z_]\w*)\s*\(/;

const MIN_SCENARIOS = 2;

function humanise(name: string): string {
  const words = name
    .replace(/[_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}
