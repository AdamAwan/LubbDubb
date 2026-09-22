import { createContext, useCallback, useContext, useEffect, useState, type JSX, type ReactNode } from 'react';
import { api } from '../api.js';
import type { PrDescriptionVersion } from '../types.js';
import { Tag } from './tag.js';

// → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written

interface PartDescriptions {
  /** The newest description of each described part, by slug. A part absent has none. */
  parts: Record<string, PrDescriptionVersion>;
  reload: () => Promise<void>;
}

/**
 * Null until the read answers, and null for good where it does not.
 *
 * The goal-level route is mounted only where `manualDescriptions` is on, so a read
 * that never answers is a deployment with the feature off — and every surface under
 * this provider draws nothing. The presence of the data decides, never a flag on the
 * payload, which is the rule the panel already learned this way.
 */
const PartDescriptionContext = createContext<PartDescriptions | null>(null);

/**
 * One read of every part's description for the whole plan.
 *
 * The board badges every part, and a read per part would be five requests to say
 * what one says — five answers arriving separately is a board whose badges appear
 * one at a time. The pull request's own page reads its one description for itself,
 * by pull request rather than by goal, because it holds no plan.
 */
export function PartDescriptionsProvider({
  issueNumber,
  children,
}: {
  issueNumber: number;
  children: ReactNode;
}): JSX.Element {
  const [parts, setParts] = useState<Record<string, PrDescriptionVersion> | null>(null);

  const read = useCallback(async (): Promise<Record<string, PrDescriptionVersion> | null> => {
    try {
      return (await api.getGoalDescriptions(issueNumber)).parts;
    } catch {
      return null;
    }
  }, [issueNumber]);

  const reload = useCallback(async (): Promise<void> => {
    setParts(await read());
  }, [read]);

  useEffect(() => {
    let live = true;
    void read().then((next) => {
      if (live) setParts(next);
    });
    return () => {
      live = false;
    };
  }, [read]);

  return (
    <PartDescriptionContext.Provider value={parts === null ? null : { parts, reload }}>
      {children}
    </PartDescriptionContext.Provider>
  );
}

/** @public the seam the board's badge reads the goal's descriptions through */
export function usePartDescriptions(): PartDescriptions | null {
  return useContext(PartDescriptionContext);
}

/**
 * A part's description's standing, said on the part itself.
 *
 * The board is where the parts are told apart, so it is where an operator reads
 * which of them wants describing — one badge per card rather than a list somewhere
 * else that has to name each part again. The description itself is written on the
 * pull request's own page, and the card is the way there.
 *
 * The unwritten state is worded as the way in rather than as a standing — `needs
 * description` named the gap and then left the operator looking for the form. It is
 * still a reading and not a button: the card around it carries the press, because a
 * control inside a card that is itself a control is two presses one pixel apart.
 *
 * Nothing is drawn for a part with no pull request open — there is nothing to
 * describe yet — or where the read did not answer.
 * → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written
 */
export function PartDescriptionTag({ slug, prNumber }: { slug: string; prNumber: number | null }): JSX.Element | null {
  const held = usePartDescriptions();
  if (held === null || prNumber === null) return null;
  const written = held.parts[slug] !== undefined;
  return (
    <span
      className="cn-desc-mark"
      title={
        written
          ? 'Somebody has said what this pull request does — open it to read it'
          : 'Nobody has said what this pull request does — open the pull request to write it'
      }
    >
      <Tag tone={written ? undefined : 'amber'}>{written ? 'described' : 'describe it \u2192'}</Tag>
    </span>
  );
}
