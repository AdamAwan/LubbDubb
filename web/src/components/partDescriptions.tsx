import { createContext, useCallback, useContext, useEffect, useState, type JSX, type ReactNode } from 'react';
import { api } from '../api.js';
import type { PrDescriptionVersion } from '../types.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md#one-panel-for-the-part-in-front

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
 * It sits above both the board and the panel because they ask the same question of
 * different parts: the board badges all five, the panel draws one. A read per part
 * would be five requests to say what one says, and five answers arriving separately
 * is a board whose badges appear one at a time.
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

/** @public the seam the board's badge and the panel both read the goal's descriptions through */
export function usePartDescriptions(): PartDescriptions | null {
  return useContext(PartDescriptionContext);
}

/**
 * A part's description's standing, said on the part itself.
 *
 * It is drawn on the board rather than in the panel because the board is where the
 * parts are told apart: which one a description belongs to is a question the wave
 * diagram already answers, and five panels stacked under it made an operator answer
 * it again by counting headings. The card itself is the control that brings that
 * part's panel to the front, so this is a reading and not a button.
 *
 * The unwritten state is worded as the way in rather than as a standing — `needs
 * description` named the gap and left the operator looking for the form, on a card
 * whose being a control is a thing they had to discover. A reading nobody can act
 * on is the same dead end the ask above it was.
 *
 * Nothing is drawn for a part with no pull request open — there is nothing to
 * describe yet — or where the read did not answer.
 * → docs/spec/07-pull-requests.md#it-is-written-against-an-open-pull-request-never-before-one
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
          ? 'Somebody has said what this pull request does — open the part to read it'
          : 'Nobody has said what this pull request does — open the part to write it'
      }
    >
      <Tag tone={written ? undefined : 'amber'}>{written ? 'described' : 'describe it \u2192'}</Tag>
    </span>
  );
}
