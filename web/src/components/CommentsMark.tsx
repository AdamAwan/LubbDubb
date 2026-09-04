import type { JSX } from 'react';
import type { PrComment } from '../types.js';
import { Icon } from './icons.js';
import { Tip, useTip } from './tip.js';

/**
 * The review threads nobody has answered, as a mark: the speech bubble, with how
 * many on its shoulder.
 *
 * It was a **fact** — `comments 1`, in the row's sub-line beside `waiting 3d` —
 * and it is the one quantity on that line that is not a quantity. The others say
 * how long something has been true; this says *somebody asked a question and it is
 * unanswered*, which is a verdict about the pull request and belongs with the
 * three that already are: the checks, the fleet's reading, and the pack.
 *
 * Amber for the reason the rest of the cockpit's ambers are — nothing is going to
 * happen to this on its own. A thread the harness has already handled is not
 * counted, so a row wearing this is a row with an answer outstanding.
 *
 * → docs/spec/17-cockpit.md#the-comments-mark
 */
export function CommentsMark({
  comments,
  reserve = false,
  onOpen,
}: {
  comments: readonly PrComment[];
  /**
   * Keep the mark's box where this row has no unanswered thread but its
   * neighbours do. The run of marks is what an eye scans down, and a row that
   * closes the slot moves every mark after it.
   */
  reserve?: boolean;
  onOpen?: () => void;
}): JSX.Element | null {
  const tip = useTip();
  const open = comments.filter((comment) => !comment.handled);
  if (open.length === 0) return reserve ? <span className="cm cm-none" aria-hidden="true" /> : null;

  const said = `${open.length} review thread${open.length === 1 ? '' : 's'} nobody has answered`;
  // A button where there is somewhere to go, a span where there is not — never a
  // span with a click handler, which no keyboard reaches. The rule the three marks
  // beside it keep.
  const Tag = onOpen === undefined ? 'span' : 'button';
  return (
    <Tag
      ref={tip.anchor as never}
      className={`cm t-amber${onOpen === undefined ? '' : ' cm-open'}`}
      {...(onOpen === undefined ? { tabIndex: 0, role: 'img' as const } : { type: 'button' as const, onClick: onOpen })}
      aria-label={`Comments: ${said}${onOpen === undefined ? '' : ' — open the pull request'}`}
      onMouseEnter={tip.open}
      onFocus={tip.open}
      onMouseLeave={tip.close}
      onBlur={tip.close}
    >
      <Icon name="chat" size={14} />
      <span className="cm-badge">{open.length}</span>
      {tip.at !== null && (
        <Tip at={tip.at}>
          <b>{said}</b>
          <ul className="cm-list">
            {open.slice(0, TIP_THREADS).map((comment) => (
              <li key={comment.id}>
                <em>{comment.author}</em>
                <span>{comment.body}</span>
              </li>
            ))}
          </ul>
          {open.length > TIP_THREADS && <span className="cm-more">{`and ${open.length - TIP_THREADS} more`}</span>}
          {onOpen !== undefined && <span className="cm-foot">click for the threads and what the fleet owes them</span>}
        </Tip>
      )}
    </Tag>
  );
}

/**
 * How many threads the tooltip quotes before it stops.
 *
 * A review comment is written for a person reading the diff, so each one is a
 * paragraph; the tooltip's job on a dense rack is to say *whose question this is*,
 * and the threads themselves are on the page the mark opens.
 */
const TIP_THREADS = 3;
