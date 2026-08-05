import type { AppState, JobAttachment } from '../types.js';

/**
 * The images an operator attached to a piece of work, drawn wherever that work is
 * (issue #249).
 *
 * **Why this is one component used twice.** An attachment starts life keyed to a
 * queued blueprint (`job:<id>`) and, at the tracker fork, changes hands to the
 * ticket that blueprint became (`issue:<n>`). Those are two different cards in the
 * cockpit, and the whole point of the re-key is that the operator can watch the
 * screenshot move from the first to the second rather than wondering where it
 * went. Two strips drawn by two components would sooner or later disagree about
 * what an attachment looks like, at exactly the moment the operator is comparing
 * them.
 *
 * **The thumbnail is the full image, scaled by CSS.** Nothing resizes or
 * re-encodes: the stored bytes are the operator's bytes, and a generated
 * thumbnail would be a second copy of the one thing this feature promises to keep
 * intact. They are small — four at most, and the strip only draws for work that
 * has any.
 *
 * The URL comes from `attachmentUrls`, never string-built here, for the reason
 * artifact chips read `artifactUrls`: it carries a short-lived capability the
 * cockpit's bearer token cannot substitute for, since an `<img>` load sends no
 * `Authorization` header of its own.
 */
export function AttachmentStrip({
  targetRef,
  attachments,
  attachmentUrls,
}: {
  /** What the attachments hang off: `job:<id>` for a queued blueprint, `issue:<n>` for a ticket. */
  targetRef: string;
  attachments: AppState['attachments'];
  attachmentUrls: AppState['attachmentUrls'];
}) {
  // An older server ships neither field; nothing is drawn rather than throwing.
  const mine = (attachments ?? []).filter((a: JobAttachment) => a.targetRef === targetRef);
  if (mine.length === 0) return null;
  return (
    <ul className="attachment-strip">
      {mine.map((attachment) => {
        const url = (attachmentUrls ?? {})[attachment.id];
        return (
          <li key={attachment.id} className="attachment-thumb">
            {/* Opened in a new tab rather than a modal: the operator wants the
                image at its own size, and the capability in the URL is already
                what makes that work. `noreferrer` keeps the capability out of the
                new document's referrer. */}
            <a href={url} target="_blank" rel="noreferrer noopener" title={`${attachment.label} — ${attachment.path}`}>
              <img src={url} alt={attachment.label} loading="lazy" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
