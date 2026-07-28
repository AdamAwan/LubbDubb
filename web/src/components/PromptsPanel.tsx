import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { PromptTemplateView } from '../types.js';

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
 */
export function PromptsPanel() {
  const [open, setOpen] = useState(false);
  const [book, setBook] = useState<{ dir: string | null; dispatcher: string; templates: PromptTemplateView[] } | null>(
    null,
  );
  const [shown, setShown] = useState<PromptTemplateView | null>(null);

  useEffect(() => {
    if (!open || book) return;
    let live = true;
    void api.getPrompts().then((b) => {
      if (live) setBook(b);
    });
    return () => {
      live = false;
    };
  }, [open, book]);

  const count = book ? book.templates.length : null;
  return (
    <div className="prompts-panel">
      <button className="btn ghost prompts-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} Prompts{count === null ? '' : ` (${count})`}
      </button>
      {open && book && <PromptList book={book} onShow={setShown} />}
      {shown && book && <PromptModal prompt={shown} dir={book.dir} onClose={() => setShown(null)} />}
    </div>
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
  book: { dir: string | null; dispatcher: string; templates: PromptTemplateView[] };
  onShow: (p: PromptTemplateView) => void;
}) {
  if (book.templates.length === 0) {
    return <p className="empty">No prompt book to show — this cockpit is running against the demo backend.</p>;
  }
  return (
    <>
      {book.dispatcher !== 'rule' && (
        <p className="muted prompts-note">
          The <code>{book.dispatcher}</code> dispatcher composes its prompts itself, so none of these are what your
          agents are being sent. They are the rule dispatcher&apos;s book.
        </p>
      )}
      <ul className="prompt-list">
        {book.templates.map((t) => (
          <li key={t.id}>
            <button className="btn ghost prompt-row" onClick={() => onShow(t)}>
              <code className="prompt-id">{t.id}</code>
              {t.overridden && <span className="chip warn">overridden</span>}
              <span className="muted prompt-doc">{firstSentence(t.doc)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
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
  // Escape closes, and the backdrop click does too. Both because a modal that can
  // only be dismissed by hitting one small button is the thing people complain
  // about, and the panel behind it is a reference an operator dips into.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="prompt-backdrop" onClick={onClose} role="presentation">
      <div className="prompt-modal" role="dialog" aria-modal="true" aria-label={prompt.id} onClick={stop}>
        <header>
          <code className="prompt-id">{prompt.id}</code>
          {prompt.overridden && <span className="chip warn">overridden</span>}
          <button className="btn ghost prompt-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="muted">{prompt.doc}</p>
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
      </div>
    </div>
  );
}

/** Keeps a click inside the dialog from reaching the backdrop's close handler. */
function stop(e: { stopPropagation: () => void }) {
  e.stopPropagation();
}
