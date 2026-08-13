import { useRef, useState } from 'react';
import { api } from '../api.js';
import type { AppState, Job } from '../types.js';
import { AttachmentStrip } from './AttachmentStrip.js';
import { SubmitButton, AsyncButton, useAsyncAction } from './AsyncButton.js';
import { relTime } from './util.js';

/**
 * The blueprint plate: a blue sheet with a white grid, drawn inline rather than
 * added to a presentation layer's own icon set because this panel is shared and
 * that set is not. It is the one glyph in the cockpit that is *not* `currentColor` — a
 * blueprint is blue the way a warning is amber, so the colour is the noun.
 */
function BlueprintMark() {
  return (
    <svg className="launch-bp" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="2" width="14" height="12" rx="1" fill="var(--blue-fill)" stroke="var(--blue)" strokeWidth="1.4" />
      <path d="M5.5 2v12M10.5 2v12M1 6h14M1 10h14" fill="none" stroke="var(--blue)" strokeWidth="0.8" opacity=".7" />
    </svg>
  );
}

/**
 * An image waiting to be launched with the blueprint (issue #249). `data` is
 * base64 of the file's bytes — the same string the wire carries — so the preview
 * and the request read one value and a thumbnail can never show something other
 * than what is sent.
 *
 * `mime` is the browser's guess and is used for the preview only: the server
 * sniffs the decoded bytes and stores *its* answer, because a client-declared
 * type is not evidence.
 */
interface Attached {
  id: string;
  name: string;
  mime: string;
  data: string;
}

/** A `File` as the composer holds it, or null for anything that is not an image. */
async function readImage(file: File): Promise<Attached | null> {
  if (!file.type.startsWith('image/')) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte screenshot
  // overflows the argument stack, which is a crash on exactly the files this
  // feature exists for.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`,
    // A pasted screenshot arrives as `image.png` or with no name at all; either
    // way the name is a label the operator reads, never a path the server uses.
    name: file.name || 'pasted image',
    mime: file.type,
    data: btoa(binary),
  };
}

/**
 * Stamp a new blueprint from the cockpit: a free-form prompt the harness turns
 * into an agent. It's queued server-side and drained by the dispatcher ahead of
 * all world-driven work — so it takes the next free slot, or waits in the queue
 * when the fleet is at capacity. Queued blueprints are listed with their place in
 * line and a cancel button; once dispatched they graduate into the Fleet.
 */
export function LaunchPanel({
  jobs,
  attachments,
  attachmentUrls,
  onChanged,
}: {
  jobs: Job[];
  /**
   * Every attachment in the snapshot; the strip below filters to this job's own
   * (issue #249). Passed whole rather than pre-filtered so the panel and the issue
   * list read one list through one component.
   */
  attachments: AppState['attachments'];
  attachmentUrls: AppState['attachmentUrls'];
  onChanged: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'code' | 'desk'>('code');
  const [open, setOpen] = useState(false);
  const [attached, setAttached] = useState<Attached[]>([]);
  // The server's refusal, in its own words — how many, how big and which formats
  // are its rules alone, so the composer states none of them and reports what it
  // was told. Two copies of a bound is how the two come to disagree.
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const submit = useAsyncAction();

  const queued = jobs.filter((j) => j.status === 'queued');

  /** Take whatever a paste, a drop or the picker produced, keeping the images. */
  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const read = await Promise.all(Array.from(files).map(readImage));
    const images = read.filter((image): image is Attached => image !== null);
    if (images.length > 0) {
      setError(null);
      setAttached((current) => [...current, ...images]);
    }
  };

  const launch = async () => {
    const text = prompt.trim();
    if (!text) return;
    try {
      await api.launchJob({
        prompt: text,
        kind,
        // Only the label and the bytes: the browser's mime is not sent, because
        // the server decides the type from the bytes and a field it ignores would
        // read as one it honours.
        ...(attached.length > 0 ? { attachments: attached.map((a) => ({ name: a.name, data: a.data })) } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
      // Rethrown so the button flashes: the message says what went wrong, the
      // flash says it went wrong at all, and the blueprint is kept for a retry.
      throw err;
    }
    setPrompt('');
    setAttached([]);
    setError(null);
    onChanged();
  };

  return (
    <div className="launch">
      <div className="launch-head">
        <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
          <BlueprintMark />
          {open ? '× New blueprint' : '+ New blueprint'}
        </button>
        {queued.length > 0 && (
          <span className="chip small" title="Blueprints waiting for a free slot">
            {queued.length} queued
          </span>
        )}
      </div>

      {open && (
        <form
          className="launch-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit.run(launch);
          }}
          // Drop anywhere on the composer, not only on the thumbnails: the target
          // an operator aims at is the box they are typing in. `preventDefault` on
          // dragover is what makes the drop fire at all; without it the browser
          // navigates away to the image, losing the half-written prompt.
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void addFiles(e.dataTransfer.files);
          }}
        >
          <textarea
            className="launch-prompt"
            placeholder="Describe the job — e.g. “Add rate-limiting to the /api/login route and open a PR.” Paste a screenshot to attach it."
            value={prompt}
            rows={3}
            onChange={(e) => setPrompt(e.target.value)}
            // ⌘/Ctrl+V of a screenshot is the common case, so it is handled where
            // the operator's cursor already is. Text pastes fall through
            // untouched — `clipboardData.files` is empty for those.
            onPaste={(e) => {
              if (e.clipboardData.files.length > 0) void addFiles(e.clipboardData.files);
            }}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter submits, matching the drawer's respond box.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void submit.run(launch);
              }
            }}
          />
          {attached.length > 0 && (
            <ul className="launch-attachments">
              {attached.map((image) => (
                <li key={image.id} className="launch-attachment">
                  {/* The thumbnail is the same base64 the request carries, scaled by
                      CSS — the stored bytes are the operator's bytes, and nothing
                      here re-encodes or resizes them. */}
                  <img src={`data:${image.mime};base64,${image.data}`} alt={image.name} />
                  <span className="launch-attachment-name" title={image.name}>
                    {image.name}
                  </span>
                  <button
                    type="button"
                    className="btn ghost launch-attachment-drop"
                    title="Remove this attachment"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => setAttached((current) => current.filter((a) => a.id !== image.id))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="launch-error" role="alert">
              {error}
            </p>
          )}
          <div className="launch-controls">
            <label className="launch-kind" title="A code job runs in a git worktree; a desk job in a scratch dir">
              <select value={kind} onChange={(e) => setKind(e.target.value as 'code' | 'desk')}>
                <option value="code">code agent</option>
                <option value="desk">desk agent</option>
              </select>
            </label>
            {/* The explicit arm of the same act: paste covers a screenshot, this
                covers a file that is already on disk. Hidden input, visible button,
                so it wears the cockpit's own chrome rather than the browser's. */}
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              className="launch-file-input"
              onChange={(e) => {
                void addFiles(e.target.files);
                // Cleared so picking the same file twice in a row still fires.
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="btn ghost"
              title="Attach an image — or paste or drop one into the prompt"
              onClick={() => picker.current?.click()}
            >
              Attach image
            </button>
            <SubmitButton phase={submit.phase} className="primary">
              Launch
            </SubmitButton>
          </div>
        </form>
      )}

      {queued.length > 0 && (
        <ul className="launch-queue">
          {queued.map((job, i) => (
            <li key={job.id} className="launch-queue-item">
              <span className="launch-pos" title="Position in the queue">
                {i + 1}
              </span>
              <span className="launch-title" title={job.prompt}>
                {job.title}
              </span>
              <span className="chip small">{job.kind}</span>
              <span className="muted launch-age">{relTime(job.createdAt)}</span>
              <AsyncButton
                className="ghost"
                onClick={() => api.cancelJob(job.id).then(onChanged)}
                title="Remove this blueprint from the queue"
              >
                cancel
              </AsyncButton>
              {/* What the operator attached, still keyed to this blueprint. When a
                  code blueprint is filed as a ticket instead of dispatched, the
                  images change hands and reappear under the issue — the same strip,
                  one row down the funnel. */}
              <AttachmentStrip targetRef={`job:${job.id}`} attachments={attachments} attachmentUrls={attachmentUrls} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
