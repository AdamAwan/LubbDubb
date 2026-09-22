// → docs/spec/31-review-packs.md#say-it-in-plainer-words

export const PLAINNESS = {
  sentenceWords: 24,
  readingEase: 60,
  hardestNamed: 3,
} as const;

/**
 * What a prose field is refused for, or null if it reads plainly enough.
 *
 * Three rules, each a number or a character the author cannot argue with. They
 * are deliberately not "write better": every one names the exact text it caught.
 */
export function plainnessRefusal(at: string, value: string): string | null {
  const prose = stripCode(value);
  const clause = CLAUSE_DASH.exec(prose);
  if (clause !== null) {
    return (
      `${at} hangs a clause off a dash. Make it two sentences, or drop the clause — the dash is how a long ` +
      `sentence hides that it is two. Was: "${value}"`
    );
  }
  if (prose.includes(';')) {
    return (
      `${at} uses a semicolon, which is a full stop that does not want to admit it. Use the full stop. ` +
      `Was: "${value}"`
    );
  }
  for (const sentence of sentences(prose)) {
    const count = words(sentence).length;
    if (count > PLAINNESS.sentenceWords) {
      return (
        `${at} has a sentence of ${count} words and the limit is ${PLAINNESS.sentenceWords}. One idea per ` +
        `sentence, and the shortest word that is still true. Was: "${sentence}"`
      );
    }
  }
  return null;
}

/**
 * How hard the pack's prose is to read, as one number, with the sentences that
 * cost it most.
 *
 * Flesch reading ease over everything the reader is shown unfolded: 100 is a
 * children's book, 60 a newspaper, 30 an academic paper. A per-field rule cannot
 * catch a register — every sentence can be short and every word still be one the
 * reader has to look up — so the pack answers for its prose as a whole.
 */
export function readingEase(fields: readonly string[]): { ease: number; hardest: string[] } {
  const all = fields.flatMap((f) => sentences(stripCode(f))).filter((s) => words(s).length > 0);
  if (all.length === 0) return { ease: 100, hardest: [] };
  let totalWords = 0;
  let totalSyllables = 0;
  const scored: [string, number][] = [];
  for (const sentence of all) {
    const ws = words(sentence);
    const syllables = ws.reduce((n, w) => n + syllablesIn(w), 0);
    totalWords += ws.length;
    totalSyllables += syllables;
    scored.push([sentence, ease(ws.length, 1, syllables)]);
  }
  return {
    ease: ease(totalWords, all.length, totalSyllables),
    hardest: scored
      .sort((a, b) => a[1] - b[1])
      .slice(0, PLAINNESS.hardestNamed)
      .map(([sentence]) => sentence),
  };
}

/** The refusal a pack over the reading-ease floor gets, or null. */
export function readingEaseRefusal(fields: readonly string[]): string | null {
  const { ease: score, hardest } = readingEase(fields);
  if (score >= PLAINNESS.readingEase) return null;
  return (
    `the pack's prose scores ${Math.round(score)} for reading ease and the floor is ${PLAINNESS.readingEase}, ` +
    `about a newspaper. Long words are what cost it, more than long sentences: use the plainest word that is ` +
    `still true, and put the identifiers in the code rather than the prose. These read hardest:\n` +
    hardest.map((s) => `- "${s}"`).join('\n')
  );
}

function ease(wordCount: number, sentenceCount: number, syllableCount: number): number {
  return 206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllableCount / wordCount);
}

/**
 * Code is not prose and is never counted: an identifier is one long word by any
 * syllable rule, and a gist that names the method it is about would fail for
 * doing the right thing.
 */
function stripCode(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split('\n')
    .filter((l) => !l.trim().startsWith('|'))
    .join('\n')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*|__/g, '');
}

function sentences(prose: string): string[] {
  return prose
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function words(sentence: string): string[] {
  return sentence
    .split(/\s+/)
    .map((w) => w.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter((w) => w !== '' && !CODE_TOKEN.test(w) && /[A-Za-z]/.test(w));
}

/**
 * A word only the code would write: an identifier, a path, a flag, a version. It
 * is dropped from both counts rather than scored, since neither rule is about it.
 */
const CODE_TOKEN = /[_/\\.:@]|\d|[a-z][A-Z]|^[A-Z]{2,}$/;

/** Vowel groups, less a silent trailing `e`. Wrong on a few words and right on the shape. */
function syllablesIn(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  const trimmed = w.replace(/(?<=[^aeiou])e$/, '');
  const groups = trimmed.match(/[aeiouy]+/g);
  return Math.max(1, groups === null ? 1 : groups.length);
}

/**
 * A dash with a space each side, mid-sentence: the clause this codebase hangs off
 * everything. A hyphen inside a word and a range are untouched.
 */
const CLAUSE_DASH = /\S\s+[—–-]\s+\S/;
