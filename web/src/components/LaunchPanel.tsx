import { useRef, useState } from 'react';
import { api } from '../api.js';
import type { AppState, Job } from '../types.js';
import { AttachmentStrip } from './AttachmentStrip.js';
import { SubmitButton, AsyncButton, useAsyncAction } from './AsyncButton.js';
import { relTime } from './util.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

function BriefMark() {
  return (
    <svg className="launch-mark" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="2.5"
        y="1.5"
        width="11"
        height="13"
        rx="1"
        fill="var(--blue-fill)"
        stroke="var(--blue)"
        strokeWidth="1.4"
      />
      <path
        d="M5 5h6M5 8h6M5 11h3.5"
        fill="none"
        stroke="var(--blue)"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity=".75"
      />
    </svg>
  );
}

interface Attached {
  id: string;
  name: string;
  mime: string;
  data: string;
}

async function readImage(file: File): Promise<Attached | null> {
  if (!file.type.startsWith('image/')) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || 'pasted image',
    mime: file.type,
    data: btoa(binary),
  };
}

export function LaunchPanel({
  jobs,
  attachments,
  attachmentUrls,
  onChanged,
}: {
  jobs: Job[];
  attachments: AppState['attachments'];
  attachmentUrls: AppState['attachmentUrls'];
  onChanged: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'code' | 'desk'>('code');
  const [open, setOpen] = useState(false);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const submit = useAsyncAction();

  const queued = jobs.filter((j) => j.status === 'queued');

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
        ...(attached.length > 0 ? { attachments: attached.map((a) => ({ name: a.name, data: a.data })) } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
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
        <Button ghost onClick={() => setOpen((o) => !o)}>
          <BriefMark />
          {open ? '× New brief' : '+ New brief'}
        </Button>
        {queued.length > 0 && <Tag title="Briefs waiting for a free slot">{queued.length} queued</Tag>}
      </div>

      {open && (
        <form
          className="launch-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit.run(launch);
          }}
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
            onPaste={(e) => {
              if (e.clipboardData.files.length > 0) void addFiles(e.clipboardData.files);
            }}
            onKeyDown={(e) => {
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
                  <Button
                    ghost
                    className="launch-attachment-drop"
                    title="Remove this attachment"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => setAttached((current) => current.filter((a) => a.id !== image.id))}
                  >
                    ×
                  </Button>
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
                e.target.value = '';
              }}
            />
            <Button
              ghost
              title="Attach an image — or paste or drop one into the prompt"
              onClick={() => picker.current?.click()}
            >
              Attach image
            </Button>
            <SubmitButton phase={submit.phase} tone="primary">
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
              <Tag>{job.kind}</Tag>
              <span className="muted launch-age">{relTime(job.createdAt)}</span>
              <AsyncButton
                ghost
                onClick={() => api.cancelJob(job.id).then(onChanged)}
                title="Remove this brief from the queue"
              >
                cancel
              </AsyncButton>
              {/* What the operator attached, still keyed to this brief. When a
                  code brief is filed as a ticket instead of dispatched, the
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
