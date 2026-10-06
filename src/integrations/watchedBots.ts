import { isWatched } from '../watchLabels.js';
import { authoredBy } from './integration.js';

// → docs/spec/37-bot-prs.md#working-one-as-the-fleets-own

export interface WatchedBotOpts {
  botAuthors?: () => readonly RegExp[];
  watchLabel?: string;
}

export interface WatchedBots {
  isBot(...names: readonly string[]): boolean;
  watched(labels: string[] | undefined): boolean;
}

export function watchedBots(opts: WatchedBotOpts): WatchedBots {
  const authors = opts.botAuthors?.() ?? [];
  const label = opts.watchLabel ?? '';
  return {
    isBot: (...names) => authoredBy(authors, ...names),
    watched: (labels) => isWatched(labels, label),
  };
}
