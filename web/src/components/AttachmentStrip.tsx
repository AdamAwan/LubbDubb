import type { AppState, JobAttachment } from '../types.js';

// → docs/spec/17-cockpit.md

export function AttachmentStrip({
  targetRef,
  attachments,
  attachmentUrls,
}: {
  targetRef: string;
  attachments: AppState['attachments'];
  attachmentUrls: AppState['attachmentUrls'];
}) {
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
