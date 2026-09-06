import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { PromptTemplateView } from '../types.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function PromptsTab() {
  const [book, setBook] = useState<{ dir: string | null; templates: PromptTemplateView[] } | null>(null);
  const [shown, setShown] = useState<PromptTemplateView | null>(null);

  useEffect(() => {
    let live = true;
    void api.getPrompts().then((b) => {
      if (live) setBook(b);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!book) return <div className="muted">Loading…</div>;
  return (
    <>
      <PromptList book={book} onShow={setShown} />
      {/* Nested on purpose: Escape closes *this* layer and nothing behind it,
          which is the shared overlay's stack rule rather than this file's
          knowing that nobody else listens. → components/Modal.tsx */}
      {shown && <PromptModal prompt={shown} dir={book.dir} onClose={() => setShown(null)} />}
    </>
  );
}

export function overridePath(dir: string | null, id: string): string {
  if (!dir) return `<promptTemplatesDir>/${id}.md`;
  const trimmed = dir.replace(/[/\\]$/, '');
  return `${trimmed}${trimmed.includes('\\') ? '\\' : '/'}${id}.md`;
}

function firstSentence(doc: string): string {
  return /^[^.]*\./.exec(doc)?.[0] ?? doc;
}

function PromptList({
  book,
  onShow,
}: {
  book: { dir: string | null; templates: PromptTemplateView[] };
  onShow: (p: PromptTemplateView) => void;
}) {
  if (book.templates.length === 0) {
    return <p className="empty">No prompt book to show — this cockpit is running against the demo backend.</p>;
  }
  return (
    <ul className="prompt-list">
      {book.templates.map((t) => (
        <li key={t.id}>
          <Button ghost className="prompt-row" onClick={() => onShow(t)}>
            <code className="prompt-id">{t.id}</code>
            {t.overridden && <Tag tone="amber">overridden</Tag>}
            {/* A retired id is still loadable — removing it would stop a customised
                deployment booting — but nothing renders it any more, and an override
                left on one is doing nothing. Said here rather than left to look live. */}
            {t.retired && <Tag>retired</Tag>}
            <span className="muted prompt-doc">{firstSentence(t.doc)}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

function PromptModal({
  prompt,
  dir,
  onClose,
}: {
  prompt: PromptTemplateView;
  dir: string | null;
  onClose: () => void;
}) {
  return (
    <Modal face="prompt" label={prompt.id} onClose={onClose}>
      <header>
        <code className="prompt-id">{prompt.id}</code>
        {prompt.overridden && <Tag tone="amber">overridden</Tag>}
        {prompt.retired && <Tag>retired</Tag>}
        <Button ghost className="prompt-close" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </header>
      <p className="muted">{prompt.doc}</p>
      {prompt.retired && (
        <p className="muted prompts-note">
          The harness no longer renders this prompt. It stays in the book so a deployment that overrode it still boots —
          an override here is simply not sent.
        </p>
      )}
      <p className="muted prompts-note">
        {prompt.overridden ? 'Overridden by ' : 'Override it by creating '}
        <code>{overridePath(dir, prompt.id)}</code>
        {prompt.placeholders.length > 0 && (
          <>
            , which may use{' '}
            {prompt.placeholders.map((p, i) => (
              <span key={p}>
                {i > 0 && ' '}
                <code>{`{${p}}`}</code>
              </span>
            ))}
          </>
        )}
        .
      </p>
      {/* pre-wrap, like the transcript pane: a template is long prose carrying
            its own hard newlines, so it must wrap on word boundaries and never
            scroll the page sideways. */}
      <pre className="prompt-text">{prompt.template}</pre>
    </Modal>
  );
}
