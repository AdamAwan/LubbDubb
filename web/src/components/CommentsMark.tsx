import type { JSX } from 'react';
import type { PrComment } from '../types.js';
import { Icon } from './icons.js';
import { Tip, useTip } from './tip.js';

// → docs/spec/17-cockpit.md

export function CommentsMark({
  comments,
  reserve = false,
  onOpen,
}: {
  comments: readonly PrComment[];
  reserve?: boolean;
  onOpen?: () => void;
}): JSX.Element | null {
  const tip = useTip();
  const open = comments.filter((comment) => !comment.handled);
  if (open.length === 0) return reserve ? <span className="cm cm-none" aria-hidden="true" /> : null;

  const said = `${open.length} review thread${open.length === 1 ? '' : 's'} nobody has answered`;
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

const TIP_THREADS = 3;
