import type { PrReplySent, PrThreadLabel } from '../types.js';
import type { ReviewAreaRule } from '../config/config.js';
import { areaNames, areasForPath } from '../reviewLabels/areas.js';
import { authorKind } from '../reviewLabels/authors.js';

// → docs/spec/18-observability.md#which-part-of-the-code-a-review-thread-was-about

const AUTHOR_ROWS = 8;

interface ReviewLabelTotal {
  threads: number;
  aboutComment: number;
  changedCode: number;
}

export interface ReviewAreaTotal extends ReviewLabelTotal {
  area: string;
}

interface ReviewAuthorTotal extends ReviewLabelTotal {
  author: string;
  kind: 'bot' | 'person';
}

export interface ReviewLabelInsights extends ReviewLabelTotal {
  resolved: number;
  /** Threads answered without the fleet ever coming back to them. */
  answeredOnce: number;
  /** Replies sent across every thread here — a thread the fleet returned to costs more than one. */
  replies: number;
  /** Threads anchored to no file at all: a comment on the pull request rather than on a line. */
  unanchored: number;
  /** Threads whose file matched no area rule. */
  unplaced: number;
  /** Threads raised by an author the provider or the repository calls a machine. */
  byBots: ReviewLabelTotal;
  /** Everything else — which is an assumption, not a finding. See `authorKind`. */
  byPeople: ReviewLabelTotal;
  byArea: ReviewAreaTotal[];
  byAuthor: ReviewAuthorTotal[];
}

interface ReviewLabelInput {
  labels: readonly PrThreadLabel[];
  replies: readonly PrReplySent[];
  areas: readonly ReviewAreaRule[];
  botAuthors: readonly string[];
}

function tally(labels: readonly PrThreadLabel[]): ReviewLabelTotal {
  return {
    threads: labels.length,
    aboutComment: labels.filter((l) => l.aboutComment).length,
    changedCode: labels.filter((l) => l.changedCode).length,
  };
}

export function buildReviewLabelInsights(input: ReviewLabelInput): ReviewLabelInsights {
  const { labels } = input;
  const placed = new Map<string, PrThreadLabel[]>();
  for (const name of areaNames(input.areas)) placed.set(name, []);

  let unanchored = 0;
  let unplaced = 0;
  for (const label of labels) {
    const areas = areasForPath(label.path, input.areas);
    if (areas === null) {
      unanchored += 1;
      continue;
    }
    if (areas.length === 0) unplaced += 1;
    for (const area of areas) placed.get(area)?.push(label);
  }

  const mine = new Set(labels.map((l) => `${l.prNumber}:${l.threadId}`));
  const repliesPerThread = new Map<string, number>();
  for (const reply of input.replies) {
    const key = `${reply.prNumber}:${reply.threadId}`;
    if (!mine.has(key)) continue;
    repliesPerThread.set(key, (repliesPerThread.get(key) ?? 0) + 1);
  }
  const replies = [...repliesPerThread.values()].reduce((sum, n) => sum + n, 0);
  const answeredOnce = [...repliesPerThread.values()].filter((n) => n === 1).length;

  const kindOf = (l: PrThreadLabel): 'bot' | 'person' => authorKind(l.author, l.authorIsBot, input.botAuthors);
  const byAuthor = [...new Set(labels.map((l) => l.author).filter((a): a is string => a !== null))]
    .map((author) => {
      const mine = labels.filter((l) => l.author === author);
      return { author, kind: kindOf(mine[0]!), ...tally(mine) };
    })
    .sort((a, b) => b.threads - a.threads || a.author.localeCompare(b.author))
    .slice(0, AUTHOR_ROWS);

  return {
    ...tally(labels),
    resolved: labels.filter((l) => l.resolved).length,
    answeredOnce,
    replies,
    unanchored,
    unplaced,
    byBots: tally(labels.filter((l) => kindOf(l) === 'bot')),
    byPeople: tally(labels.filter((l) => kindOf(l) === 'person')),
    byArea: [...placed].map(([area, rows]) => ({ area, ...tally(rows) })),
    byAuthor,
  };
}
