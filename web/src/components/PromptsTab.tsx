import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { PromptTemplateView } from '../types.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';

/**
 * What the harness says to its agents. Every agent-facing prompt the rule
 * dispatcher composes has a stable id and a wording an operator may replace, and
 * until now the only way to read either was the source: the built-in text lives
 * in `src/dispatcher/promptTemplates.ts` and the override in a file on the
 * server's disk, neither of which the person watching the cockpit necessarily
 * has to hand.
 *
 * **Fetched on open, never polled** — the mirror of the work graph's reason
 * rather than a copy of it. The graph is fetched because it only ever grows;
 * this is fetched because it never changes at all: `loadPromptTemplates` reads
 * the override directory once at boot, so re-sending the book on every
 * `/api/state` poll would be paying for a constant.
 *
 * **Read-only.** Overriding a prompt stays a file drop into `promptTemplatesDir`,
 * which is why the panel names that path for each id whether or not one exists —
 * that is what makes a viewer actionable without a write route whose only honest
 * answer to "when does this take effect" is "at the next restart".
 *
 * A **tab of the settings modal** since #244, rather than a disclosure hanging
 * under the Work panel. The book is operator-facing configuration and belongs
 * beside the rest of it; the disclosure toggle is gone because a tab already
 * answers "is this open", and two collapse states in one panel is one too many.
 */
export function PromptsTab() {
  const [book, setBook] = useState<{ dir: string | null; templates: PromptTemplateView[] } | null>(null);
  const [shown, setShown] = useState<PromptTemplateView | null>(null);

  // Fetched when the tab first mounts. The modal keeps every tab's body mounted
  // once visited, so switching away and back does not re-fetch a constant.
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

/**
 * The file an operator would create (or has created) to override prompt `id`.
 * The separator is taken from the directory rather than assumed: the server
 * resolves `promptTemplatesDir` to an absolute path, so on Windows it arrives
 * backslashed and a hardcoded `/` would hand the operator a path in two
 * dialects — one they cannot paste into a shell.
 */
export function overridePath(dir: string | null, id: string): string {
  if (!dir) return `<promptTemplatesDir>/${id}.md`;
  const trimmed = dir.replace(/[/\\]$/, '');
  return `${trimmed}${trimmed.includes('\\') ? '\\' : '/'}${id}.md`;
}

/** The doc's opening sentence — enough to tell the rows apart in the list. */
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
            {t.overridden && <span className="chip warn">overridden</span>}
            {/* A retired id is still loadable — removing it would stop a customised
                deployment booting — but nothing renders it any more, and an override
                left on one is doing nothing. Said here rather than left to look live. */}
            {t.retired && <span className="chip">retired</span>}
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
        {prompt.overridden && <span className="chip warn">overridden</span>}
        {prompt.retired && <span className="chip">retired</span>}
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
